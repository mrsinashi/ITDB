"""SSH для сбора с сервера DHCP (этап 28): прочитать файл аренд.

Сервер у пользователя – старый Linux (CentOS 6, OpenSSH 5.3): ключ сервера и
подпись только ssh-rsa (SHA-1), ключи ed25519 он не понимает. Поэтому paramiko
версии 4 (в 5-й старые алгоритмы убраны) и ключ ITDB – RSA.

Вход – ключом ITDB (хранится зашифрованным в настройках источника, на диск не
пишется: служба работает без права записи) или паролем. Ключ на сервер ставит
install_key (по паролю) – сразу с ограничением: по этому ключу сервер выполняет
только «cat файл», что бы ни просили; без терминала и пробросов.

Ключ сервера запоминается при первом подключении (host_key); если потом сервер
предъявит другой – отказ: это либо переустановка, либо подмена.
"""
import base64
import hashlib
import io
import re
import shlex
import socket

import paramiko
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from scan_http import SourceError

TIMEOUT = 15
MAX_BYTES = 64 * 1024 * 1024
KEY_BITS = 3072
KEY_COMMENT = "itdb"
# Ограничения ключа в authorized_keys: только заданная команда
KEY_OPTIONS = "no-pty,no-port-forwarding,no-X11-forwarding,no-agent-forwarding"
PATH_RE = re.compile(r"^/[\w./+@:-]+$")
MAX_CONFIGS = 30
# Метка перед каждым файлом в выводе сервера
FILE_MARK = "#ITDB-FILE "
FILE_LINE = re.compile(r"(?m)^" + re.escape(FILE_MARK) + r"(\S+)[ \t]*\r?$\n?")


def split_host(address):
    """«dhcp.lan», «192.168.0.5:2222», «ssh://dhcp.lan» → (имя, порт)."""
    text = (address or "").strip()

    if "://" in text:
        text = text.split("://", 1)[1]

    text = text.strip("/")

    if "@" in text:
        text = text.rsplit("@", 1)[1]

    host, _, port = text.partition(":")

    if not host or " " in host or "/" in host:
        raise SourceError("Адрес – имя или IP сервера, например 192.168.0.5 (порт – через двоеточие).")

    if port and not (port.isdigit() and 0 < int(port) < 65536):
        raise SourceError(f"Порт «{port}» – не число от 1 до 65535.")

    return host, int(port) if port else 22


def clean_address(address):
    host, port = split_host(address)
    return host if port == 22 else f"{host}:{port}"


def split_paths(text):
    """Файлы через пробел или с новой строки; только полные пути без спецзнаков
    (путь попадает в команду на сервере)."""
    paths = (text or "").split()

    if not paths:
        raise SourceError("Укажи файл, например /var/lib/dhcpd/dhcpd.leases.")

    for path in paths:
        if not PATH_RE.match(path) or ".." in path:
            raise SourceError(f"Путь «{path}» – нужен полный, с «/» в начале, без пробелов и кавычек.")

    return paths


def config_paths(configs):
    """Файлы настроек (dhcpd.conf и его части): список полных путей, пустые пропускаются."""
    result = []

    for text in configs or []:
        if (text or "").strip():
            for path in split_paths(text):
                if path not in result:
                    result.append(path)

    if len(result) > MAX_CONFIGS:
        raise SourceError(f"Файлов настроек слишком много (больше {MAX_CONFIGS}).")

    return result


def all_paths(params):
    """Все файлы подключения: аренды, за ними – настройки."""
    paths = split_paths(params.get("path"))
    return paths + [path for path in config_paths(params.get("configs")) if path not in paths]


def read_command(paths):
    """Перед каждым файлом – строка-метка: по ней видно, какие файлы сервер отдал
    (ключ на сервере выполняет команду, записанную при его установке)."""
    return "; ".join(f"echo; echo '{FILE_MARK}{path}'; cat -- {shlex.quote(path)}" for path in paths)


def split_files(text):
    """Вывод сервера → [(путь, текст)]. Меток нет (ключ поставлен версией до 28в:
    просто «cat») – [(None, весь текст)]."""
    parts = FILE_LINE.split(text)

    if len(parts) == 1:
        return [(None, text)]

    return [(parts[index], parts[index + 1]) for index in range(1, len(parts), 2)]


def generate_key():
    """Новый закрытый ключ RSA (текст PEM)."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=KEY_BITS)
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption(),
    ).decode("ascii")


def load_key(private_pem):
    try:
        return paramiko.RSAKey.from_private_key(io.StringIO(private_pem))
    except paramiko.SSHException as err:
        raise SourceError(f"Ключ ITDB испорчен ({err}). Создай новый.")


def public_line(private_pem):
    """Открытый ключ строкой «ssh-rsa AAAA… itdb»."""
    key = load_key(private_pem)
    return f"{key.get_name()} {key.get_base64()} {KEY_COMMENT}"


def authorized_line(private_pem, paths):
    """Строка для ~/.ssh/authorized_keys: ключ, которому можно только прочитать файл."""
    return f'command="{read_command(paths)}",{KEY_OPTIONS} {public_line(private_pem)}'


def fingerprint(host_key):
    """«ssh-rsa AAAA…» → «SHA256:…», как показывает ssh-keygen -l."""
    try:
        blob = base64.b64decode(host_key.split()[1])
    except (IndexError, ValueError):
        return ""

    return "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")


# ---------- Подключение ----------


def _reason(host, err):
    if isinstance(err, socket.gaierror):
        return f"Не найден сервер «{host}»: проверь имя (или DNS на сервере ITDB)."

    if isinstance(err, ConnectionRefusedError):
        return f"{host} не принимает подключения SSH на этом порту."

    if isinstance(err, (socket.timeout, TimeoutError)):
        return f"{host} не ответил за {TIMEOUT} с."

    if isinstance(err, OSError) and err.errno in (101, 113):
        return f"Нет маршрута до {host}: сервер ITDB его не видит по сети."

    return f"Не удалось подключиться к {host}: {err}"


OLD_RSA = {"pubkeys": ["rsa-sha2-512", "rsa-sha2-256"]}
# OpenSSH до 7.2 подписи RSA с SHA-2 не знает
OLD_OPENSSH = re.compile(r"OpenSSH_(?:[1-6]\.|7\.[01](?!\d))")


class Session:
    """Подключение по SSH. info: host_key – ключ сервера, auth – чем вошли
    (key / password), server – версия сервера."""

    def __init__(self, params, use_key=True, use_password=True):
        self.host, self.port = split_host(params.get("url"))
        self.login = (params.get("login") or "").strip()
        self.pinned = params.get("host_key")
        self.transport = None
        self.info = {}

        if not self.login:
            raise SourceError("Укажи логин.")

        key = params.get("ssh_key") if use_key else None
        password = params.get("password") if use_password else None

        if not key and not password:
            raise SourceError("Нет ни пароля, ни ключа: укажи пароль или поставь ключ на сервер.")

        try:
            self._open()
            self._auth(key, password)
        except Exception:
            self.close()
            raise

    def _open(self, old_rsa=False):
        """Соединение и проверка ключа сервера. old_rsa – подписывать по-старому (ssh-rsa)."""
        self.close()

        try:
            sock = socket.create_connection((self.host, self.port), timeout=TIMEOUT)
        except OSError as err:
            raise SourceError(_reason(self.host, err))

        try:
            self.transport = paramiko.Transport(sock, disabled_algorithms=OLD_RSA if old_rsa else None)
            self.transport.start_client(timeout=TIMEOUT)
        except (paramiko.SSHException, EOFError, OSError) as err:
            raise SourceError(f"{self.host}: не удалось договориться о шифровании SSH ({err}).")

        key = self.transport.get_remote_server_key()
        seen = f"{key.get_name()} {key.get_base64()}"
        self.info["host_key"] = seen
        self.info["server"] = (self.transport.remote_version or "").replace("SSH-2.0-", "")

        if self.pinned and self.pinned.split()[:2] != seen.split()[:2]:
            raise SourceError(
                f"Ключ сервера {self.host} изменился (был {fingerprint(self.pinned)}, стал {fingerprint(seen)}). "
                "Если сервер переустановили – убери отпечаток (✕) и проверь снова."
            )

    def _auth(self, key, password):
        errors = []

        if key:
            try:
                self._auth_key(load_key(key))
                self.info["auth"] = "key"
                return
            except paramiko.AuthenticationException:
                errors.append("ключ не принят")
            except paramiko.SSHException as err:
                errors.append(f"ключ: {err}")

        if password:
            if not self.transport.is_active():
                self._open()

            try:
                self.transport.auth_password(self.login, password)
                self.info["auth"] = "password"
                return
            except paramiko.BadAuthenticationType as err:
                errors.append("вход по паролю на сервере запрещён (можно: " + ", ".join(err.allowed_types) + ")")
            except paramiko.AuthenticationException:
                errors.append("неверный логин или пароль")
            except paramiko.SSHException as err:
                errors.append(f"пароль: {err}")

        raise SourceError(f"{self.host} не пустил: " + "; ".join(errors) + ".")

    def _auth_key(self, pkey):
        """Вход ключом. Старый сервер (как OpenSSH 5.3 на CentOS 6) не сообщает,
        какие подписи понимает, и знает только ssh-rsa: ему – сразу старая подпись;
        незнакомому серверу, который промолчал и ключ не принял, – вторая попытка
        со старой подписью в новом соединении."""
        if OLD_OPENSSH.search(self.transport.remote_version or ""):
            self._open(old_rsa=True)
            self.transport.auth_publickey(self.login, pkey)
            return

        try:
            self.transport.auth_publickey(self.login, pkey)
        except paramiko.AuthenticationException:
            if self.transport.server_extensions.get("server-sig-algs"):
                raise

            self._open(old_rsa=True)
            self.transport.auth_publickey(self.login, pkey)

    def run(self, command, stdin=None):
        """Выполнить команду: (вывод, ошибки, код). Со входом по ключу ITDB сервер
        выполняет свою команду (чтение файла), а не эту."""
        try:
            channel = self.transport.open_session(timeout=TIMEOUT)
            channel.settimeout(TIMEOUT)
            channel.exec_command(command)

            # Сервер мог уже всё отдать и закрыть канал – вывод всё равно дочитается
            try:
                if stdin is not None:
                    channel.sendall(stdin)

                channel.shutdown_write()
            except (paramiko.SSHException, EOFError, OSError):
                pass

            out = bytearray()

            while True:
                chunk = channel.recv(65536)

                if not chunk:
                    break

                out += chunk

                if len(out) > MAX_BYTES:
                    raise SourceError("Файл больше 64 МБ – это точно файл аренд DHCP?")

            err = channel.makefile_stderr("rb").read(4096)
            code = channel.recv_exit_status()
            return bytes(out), err.decode("utf-8", errors="replace").strip(), code
        except socket.timeout:
            raise SourceError(f"{self.host} не ответил за {TIMEOUT} с.")
        except (paramiko.SSHException, EOFError, OSError) as err:
            raise SourceError(f"{self.host}: соединение оборвалось ({err}).")

    def close(self):
        if self.transport is not None:
            self.transport.close()
            self.transport = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def read_files(params):
    """Файлы с сервера [(путь, текст)] и сведения о подключении. Путь None – сервер
    отдал всё одним куском (ключ на нём – с прежней командой)."""
    paths = all_paths(params)

    with Session(params) as session:
        out, err, code = session.run(read_command(paths))
        info = session.info

    files = split_files(out.decode("utf-8", errors="replace"))
    # Не прочитался файл настроек – не повод терять аренды: об этом скажет сборщик
    leases_read = files[0][0] in (None, paths[0]) and files[0][1].strip()

    if not leases_read and (code != 0 or err):
        raise SourceError("Файл не прочитать: " + (err or f"код {code}") + ". Проверь путь и права пользователя.")

    info["read_error"] = err if (code != 0 or err) else None
    return files, info


def install_key(params):
    """Поставить ключ ITDB на сервер (вход – по паролю): строка в
    ~/.ssh/authorized_keys с ограничением «только читать файл». Прежние строки
    ITDB заменяются. Ответ – сведения о подключении."""
    paths = all_paths(params)
    line = authorized_line(params["ssh_key"], paths)
    marker = shlex.quote(" " + KEY_COMMENT + "$")
    script = (
        "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && "
        f"grep -v {marker} ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.itdb; "
        "cat >> ~/.ssh/authorized_keys.itdb && mv ~/.ssh/authorized_keys.itdb ~/.ssh/authorized_keys && "
        "chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && "
        # CentOS с SELinux: без верной метки sshd файл не прочтёт (как делает ssh-copy-id)
        "{ test -x /sbin/restorecon && /sbin/restorecon ~/.ssh ~/.ssh/authorized_keys >/dev/null 2>&1; true; }"
    )

    if not params.get("password"):
        raise SourceError("Чтобы поставить ключ, введи пароль пользователя на сервере.")

    with Session(params, use_key=False) as session:
        _, err, code = session.run(script, stdin=(line + "\n").encode("ascii"))
        info = session.info

    if code != 0:
        raise SourceError("Ключ не записался: " + (err or f"код {code}") + ".")

    # Проверка: по ключу сервер должен отдать файл
    try:
        read_files(dict(params, password=None, host_key=info["host_key"]))
    except SourceError as err:
        raise SourceError(f"Ключ записан, но вход по нему не удался: {err}")

    return info
