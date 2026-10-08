"""CLI del backend RS.

Uso:
  python -m backend run [--host 127.0.0.1] [--port 5000]
  python -m backend create-user --username pepe --role driver [--password ...]
    (sin --password, la pide de forma segura por teclado)
"""
import argparse
import getpass
import sys

from backend import create_app


def cmd_run(args):
    app = create_app()
    app.run(host=args.host, port=args.port, debug=False)


def cmd_create_user(args):
    app = create_app()
    with app.app_context():
        db = app.get_db()
        row = db.execute("SELECT id FROM users WHERE username = ?", (args.username,)).fetchone()
        if row:
            print(f"El usuario '{args.username}' ya existe.", file=sys.stderr)
            sys.exit(1)
        password = args.password or getpass.getpass("Contraseña: ")
        if len(password) < 8:
            print("La contraseña debe tener al menos 8 caracteres.", file=sys.stderr)
            sys.exit(1)
        from backend import iso, utcnow

        db.execute(
            "INSERT INTO users (username, password_hash, role, active, created_at) VALUES (?,?,?,?,?)",
            (args.username, app.hash_password(password), args.role, 1, iso(utcnow())),
        )
        db.commit()
        print(f"Usuario '{args.username}' creado con rol '{args.role}'.")


def main():
    p = argparse.ArgumentParser(prog="python -m backend")
    sub = p.add_subparsers(dest="cmd")
    r = sub.add_parser("run", help="Levantar el servidor")
    r.add_argument("--host", default="127.0.0.1")
    r.add_argument("--port", type=int, default=5000)
    c = sub.add_parser("create-user", help="Crear un usuario (solo para el admin)")
    c.add_argument("--username", required=True)
    c.add_argument("--role", default="driver", choices=("admin", "driver"))
    c.add_argument("--password", default=None)
    args = p.parse_args()
    if args.cmd == "create-user":
        cmd_create_user(args)
    else:
        cmd_run(args)


if __name__ == "__main__":
    main()
