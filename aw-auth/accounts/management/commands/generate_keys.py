"""Generate an RSA keypair for RS256 JWT signing.

Writes PEM files to the configured key paths (gitignored). Restart the server
afterwards so RS256 activates.
"""

from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from django.conf import settings
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Generate an RSA keypair (private.pem / public.pem) for RS256 JWTs."

    def add_arguments(self, parser):
        parser.add_argument(
            "--force",
            action="store_true",
            help="Overwrite existing keys (invalidates all issued tokens).",
        )
        parser.add_argument("--bits", type=int, default=2048)

    def handle(self, *args, **options):
        priv_path = Path(settings.JWT_PRIVATE_KEY_PATH)
        pub_path = Path(settings.JWT_PUBLIC_KEY_PATH)

        if priv_path.exists() and not options["force"]:
            self.stdout.write(
                self.style.WARNING(
                    f"{priv_path} already exists. Use --force to overwrite "
                    "(this invalidates all existing tokens)."
                )
            )
            return

        priv_path.parent.mkdir(parents=True, exist_ok=True)
        key = rsa.generate_private_key(
            public_exponent=65537, key_size=options["bits"]
        )
        priv_path.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        pub_path.write_bytes(
            key.public_key().public_bytes(
                serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        )
        self.stdout.write(self.style.SUCCESS(f"Wrote {priv_path}"))
        self.stdout.write(self.style.SUCCESS(f"Wrote {pub_path}"))
        self.stdout.write(
            "Keep the private key secret. Restart the server to activate RS256."
        )
