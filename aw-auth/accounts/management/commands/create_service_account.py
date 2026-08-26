"""Create a service account and print its client_id + secret (shown once).

Example (collector):
    uv run python manage.py create_service_account collector \
        --scopes ingest:write asset:read
"""

from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from accounts.models import ServiceAccount


class Command(BaseCommand):
    help = "Create a service account; prints the client_id and secret once."

    def add_arguments(self, parser):
        parser.add_argument("name")
        parser.add_argument(
            "--scopes",
            nargs="+",
            default=["ingest:write", "asset:read"],
            help="Scopes granted to this account.",
        )
        parser.add_argument(
            "--expires-days",
            type=int,
            default=None,
            help="Optional expiry in days.",
        )

    def handle(self, *args, **options):
        sa = ServiceAccount(
            name=options["name"],
            client_id=ServiceAccount.new_client_id(),
            scopes=options["scopes"],
        )
        secret = ServiceAccount.new_secret()
        sa.set_secret(secret)
        if options["expires_days"]:
            sa.expires_at = timezone.now() + timedelta(days=options["expires_days"])
        sa.save()

        self.stdout.write(self.style.SUCCESS(f"Created service account '{sa.name}'"))
        self.stdout.write("")
        self.stdout.write(f"  client_id:     {sa.client_id}")
        self.stdout.write(f"  client_secret: {secret}")
        self.stdout.write(f"  scopes:        {', '.join(sa.scopes)}")
        self.stdout.write("")
        self.stdout.write(
            self.style.WARNING(
                "Store the secret now — it is hashed and cannot be shown again."
            )
        )
