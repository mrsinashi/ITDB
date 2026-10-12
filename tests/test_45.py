"""Этап 45: столбец «Доступ» у принтеров (администратор показывает логин и пароль Web по
своему паролю), подключение принтеров к ПК номерами записей, «Сканировать» на «Сети» –
часть подсетей, только аренды или только привязки DHCP."""
import time

import pytest

import api_printers
import scan_dhcp
import scan_net
from conftest import PASSWORDS, add_computer, get_row, ok
from test_printers import add_printer
from test_scan_28 import Ssh, hosts, reset_ssh, setup_dhcp, ssh_port  # noqa: F401
from test_scan_collect import secret_key  # noqa: F401


@pytest.fixture(autouse=True)
def no_attempts():
    api_printers.show_attempts.clear()


def collect_only(admin, kind, body=None, status=200):
    response = admin.post(f"/api/scan/sources/{kind}/collect", json=body)

    if status != 200:
        assert response.status_code == status, response.text
        return response.json()

    run = ok(response)

    for _ in range(200):
        run = ok(admin.get(f"/api/scan/runs/{run['id']}"))

        if run["status"] != "running":
            return run

        time.sleep(0.05)

    raise AssertionError("сбор не закончился")


def test_access_column_and_admin_password(admin, editor, reader, room):
    columns = ok(reader.get("/api/columns"))
    access = next(c for c in columns["printer_columns"] if c["key"] == "web_auth")
    assert access["short"] == "Доступ" and access["card"] == "Доступ"

    pid = add_printer(editor, room["room"])
    ok(editor.put(f"/api/printers/{pid}/web-auth", json={"login": "", "password": "secret 1"}))
    url = f"/api/printers/{pid}/web-auth/show"

    # Администратору логин не нужен – свой пароль
    assert ok(admin.post(url, json={"password": PASSWORDS["admin"]})) == {"login": None, "password": "secret 1"}
    bad = admin.post(url, json={"password": "wrong"})
    assert bad.status_code == 403 and bad.json()["detail"] == "Неверный пароль."
    # Остальным – логин и пароль администратора
    assert editor.post(url, json={"password": PASSWORDS["editor"]}).status_code == 403
    assert reader.post(url, json={"login": "", "password": PASSWORDS["admin"]}).status_code == 403
    assert ok(reader.post(url, json={"login": "admin", "password": PASSWORDS["admin"]}))["password"] == "secret 1"


def test_links_by_ids(editor, reader, room):
    """Окошко подключения шлёт номера записей [[id, usb]] – и у принтера, и у ПК (ПК с
    одинаковым именем различаются)."""
    pc1 = add_computer(editor, room["room"], hostname="twin")
    pc2 = add_computer(editor, room["room"], hostname="twin")
    pid = add_printer(editor, room["room"], name="pr-1")
    version = next(r for r in ok(reader.get("/api/printers"))["rows"] if r["id"] == pid)["version"]
    data = ok(editor.patch(f"/api/printers/{pid}", json={"computers": [[pc2, True]], "_version": version}))
    assert data["updated"]["computer_refs"] == [{"id": pc2, "title": "twin", "usb": True}]
    assert get_row(reader, pc1)["printers"] is None and get_row(reader, pc2)["printers"] == "pr-1 [usb]"

    version = get_row(reader, pc1)["version"]
    data = ok(editor.patch(f"/api/computers/{pc1}", json={"printers": [[pid, False]], "_version": version}))
    assert data["updated"]["printer_refs"] == [{"id": pid, "title": "pr-1", "usb": False}]
    refs = next(r for r in ok(reader.get("/api/printers"))["rows"] if r["id"] == pid)["computer_refs"]
    assert sorted((r["id"], r["usb"]) for r in refs) == sorted([(pc1, False), (pc2, True)])


def test_net_some_subnets(admin, monkeypatch):
    asked = []

    def probe(ip, options, dns):
        asked.append(ip)
        return None

    monkeypatch.setattr(scan_net, "probe", probe)
    monkeypatch.setattr(scan_net, "arp_table", lambda: {})
    ok(admin.patch("/api/scan/sources/net", json={"enabled": True}))
    ok(admin.post("/api/scan/subnets", json={"cidr": "10.0.7.0/29"}))
    ok(admin.post("/api/scan/subnets", json={"cidr": "10.0.9.0/30"}))
    ok(admin.post("/api/scan/subnets", json={"cidr": "10.0.8.0/24", "scan": False}))

    run = collect_only(admin, "net", {"subnets": ["10.0.9.0/30"]})
    assert run["status"] == "ok" and run["stats"]["total"] == 2 and run["stats"]["subnets"] == 1
    assert run["stats"]["only"] == {"subnets": ["10.0.9.0/30"]}
    assert sorted(asked) == ["10.0.9.1", "10.0.9.2"]

    # Все отмеченные – обычный сбор; не отмеченная «Сканировать» и пустой выбор – отказ
    asked.clear()
    run = collect_only(admin, "net", {"subnets": ["10.0.9.0/30", "10.0.7.0/29"]})
    assert run["stats"]["total"] == 8 and "only" not in run["stats"]
    assert "подсети" in collect_only(admin, "net", {"subnets": ["10.0.8.0/24"]}, 400)["detail"]
    assert collect_only(admin, "net", {"subnets": []}, 400)["detail"] == "Не выбраны подсети."


def test_dhcp_leases_or_configs(admin, ssh_port):  # noqa: F811
    conf = "/etc/dhcp/hosts.conf"
    Ssh.files[conf] = "host a { hardware ethernet 00:1b:a9:00:06:01; fixed-address 10.0.6.1; }"
    setup_dhcp(admin, ssh_port, configs=[conf])
    run = collect_only(admin, "dhcp")
    assert run["status"] == "ok" and run["stats"]["fixed"] == 4, run
    leases = set(hosts("dhcp"))
    assert "10.0.6.1" in hosts(scan_dhcp.CONF_SOURCE)

    # Только аренды: привязки остаются как были, в итоге их нет
    Ssh.files[conf] = "# пусто"
    run = collect_only(admin, "dhcp", {"leases": True, "configs": False})
    assert run["status"] == "ok" and run["stats"]["fixed"] == 0 and run["stats"]["only"] == {"leases": True, "configs": False}
    assert conf not in run["message"]   # о файлах настроек не предупреждает (только о входе по паролю)
    assert "10.0.6.1" in hosts(scan_dhcp.CONF_SOURCE)

    # Только привязки: аренды не трогаются (и не помечаются ушедшими)
    Ssh.files[scan_dhcp.DEFAULT_PATH] = "# пусто"
    run = collect_only(admin, "dhcp", {"leases": False})
    assert run["status"] == "ok" and run["stats"] == dict(run["stats"], total=0, fixed=0, active=0)
    assert set(hosts("dhcp")) == leases and not any((row.data or {}).get("gone") for row in hosts("dhcp").values())
    assert hosts(scan_dhcp.CONF_SOURCE) == {}

    assert collect_only(admin, "dhcp", {"leases": False, "configs": False}, 400)["detail"] == "Не выбрано, что собрать из DHCP."
