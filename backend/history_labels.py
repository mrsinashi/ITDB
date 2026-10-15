"""Подписи Истории – как на странице (этап 53): копия словарей
frontend/static/js/columns.js (ENTITY_LABELS, SIMPLE_FIELD_LABELS, LOCATION_FIELD_LABELS)
для поиска по Истории на сервере и текста Ctrl+Z. Совпадение с columns.js проверяет
tests/test_53.py – подпись менять в обоих местах."""

ENTITY_LABELS = {
    "computers": "ПК",
    "locations": "Расположение",
    "choices": "Справочник",
    "field_defs": "Поле",
    "column_styles": "Оформление",
    "users": "Пользователь",
    "scan_sources": "Подключение",
    "scan_subnets": "Подсеть",
    "scan_records": "Запись",
    "scan_aliases": "Название",
    "scan_schedule": "Расписание",
    "scan_marks": "Пометка сканера",
    "scan_antivirus": "Антивирусы",
    "table_marks": "Выделение",
    "app_settings": "Настройка",
    "naming": "Своё имя",
    "printers": "Принтер",
    "printer_models": "Модель принтера",
    "cartridges": "Картридж",
    "moves": "Движение",
    "item_types": "Тип техники",
}

SIMPLE_FIELD_LABELS = {
    "value": "Значение",
    "color": "Цвет текста",
    "bg_color": "Фон",
    "bold": "Жирный",
    "italic": "Курсив",
    "underline": "Подчёркнутый",
    "chip": "Фон блочком",
    "label": "Название",
    "archived": "Архив",
    "role": "Роль",
    "password": "Пароль",
    "created": "Создан",
    "deleted": "Удалено",
    "login": "Логин",
    "full_name": "ФИО",
    "position": "Должность",
    # Сканирование (этап 24)
    "enabled": "Включён",
    "url": "Адрес сервера",
    "domain": "Домен XMPP",
    "user_token": "Токен пользователя",
    "app_token": "Токен приложения",
    "verify_tls": "Проверять сертификат",
    "fresh_days": "Актуальны, дней",
    # DHCP по SSH, сеть, расписание (этап 28)
    "path": "Файл",
    "configs": "Файлы настроек",
    "ssh_key": "Ключ SSH",
    "key_installed": "Ключ поставлен на сервер",
    "host_key": "Отпечаток сервера",
    "names": "Имена (NetBIOS, DNS)",
    "ports": "Проверять порты",
    "online_watch": "Проверять «в сети»",
    "online_minutes": "Проверка «в сети», мин",
    "run_mode": "Запуск",
    "run_time": "Время",
    "run_days": "Дни",
    "cidr": "Подсеть",
    "purpose": "Назначение",
    "building": "Адрес",
    "scan": "Сканировать",
    "note": "Примечание",
    # Сопоставление записей GLPI / GSIT с ПК (этап 25)
    "link": "Это ПК",
    "reject": "Не этот ПК",
    "reset": "Решения забыты",
    # Соответствия названий (этап 25б)
    "same": "Одно и то же",
    "differ": "Разное",
    "keep": "В таблице своё",
    "board": "Материнская плата",
    # Пометки сканера (этап 26б)
    "strike": "Зачёркнутый",
    "frame": "Рамка",
    "always": "Без кнопки",
    # Столбец «Антивирусы» (этап 26д)
    "show": "Показывать",
    "hidden": "Не показывать",
    "name": "Название",  # своё название антивируса (этап 26е)
    "vnc_default": "VNC",
    "name_keep": "Своё имя",  # имя ПК не по правилу (этап 35)
    # Модели принтеров (этап 44)
    "kind": "Тип",
    "maker": "Производитель",
    "model": "Модель",
    "duplex": "Дуплекс",
    "cartridges": "Картриджи",  # этап 47
}

LOCATION_FIELD_LABELS = {
    "name": "Название",
    "code": "Код",
    "sort": "Порядок",
    "kind": "Тип",
    "parent_id": "Расположение",  # место кабинета, этап 58
    "archived": "Архив",
    "created": "Создан",
    # Правило имён ПК (этап 35)
    "name_part": "Часть имени ПК",
    "name_own": "Только своя часть",
    "name_single": "Одно место",
}
