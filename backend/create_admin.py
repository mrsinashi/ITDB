import getpass
import sys

from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlalchemy import func

from auth import hash_password
from db import SessionLocal
from models import User


def main():
    session = SessionLocal()

    try:
        login = input("Логин администратора [admin]: ").strip() or "admin"
        password = getpass.getpass("Пароль: ")
        confirm = getpass.getpass("Повторите пароль: ")

        if password != confirm:
            print("Пароли не совпадают.")
            return 1

        if len(password) < 6:
            print("Пароль слишком короткий. Минимум 6 символов.")
            return 1

        exists = (
            session.query(User)
            .filter(func.lower(User.login) == login.lower())
            .first()
        )

        if exists:
            print("Такой пользователь уже существует.")
            return 1

        session.add(
            User(
                login=login.lower(),
                password_hash=hash_password(password),
                role="admin",
            )
        )

        session.commit()

        print("Администратор создан.")

    except Exception as e:
        session.rollback()
        print(f"Ошибка: {e}")
        return 1

    finally:
        session.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())