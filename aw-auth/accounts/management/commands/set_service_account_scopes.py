"""Set (replace) the scopes on an existing service account, keeping its
client_id and secret. Use this to grant a new scope without re-minting creds.

Example (grant the collector the new dequeue scope, spec 12):
    uv run python manage.py set_service_account_scopes collector \
        --scopes ingest:write asset:read scan:dequeue
"""

from django.core.management.base import BaseCommand, CommandError

from accounts.models import ServiceAccount


class Command(BaseCommand):
    help = "Replace the scopes on an existing service account (creds unchanged)."

    def add_arguments(self, parser):
        parser.add_argument("name", help="The service account name.")
        parser.add_argument(
            "--scopes",
            nargs="+",
            required=True,
            help="The full scope list to set (replaces the existing scopes).",
        )

    def handle(self, *args, **options):
        name = options["name"]
        matches = list(ServiceAccount.objects.filter(name=name))
        if not matches:
            raise CommandError(f"No service account named '{name}'.")
        if len(matches) > 1:
            raise CommandError(
                f"{len(matches)} service accounts named '{name}'; "
                "resolve the duplicate in the Django admin first."
            )
        sa = matches[0]
        old = list(sa.scopes)
        sa.scopes = options["scopes"]
        sa.save(update_fields=["scopes"])
        self.stdout.write(self.style.SUCCESS(f"Updated scopes for '{sa.name}'"))
        self.stdout.write(f"  client_id: {sa.client_id}")
        self.stdout.write(f"  was:       {', '.join(old) or '(none)'}")
        self.stdout.write(f"  now:       {', '.join(sa.scopes)}")
