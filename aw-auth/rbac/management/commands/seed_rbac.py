"""Seed the default permission catalog and system roles.

Idempotent: safe to run repeatedly. Mirrors docs/specs/02-auth-service-spec.md §5.
"""

from django.core.management.base import BaseCommand
from django.db import transaction

from rbac.models import Permission, Role

PERMISSIONS = [
    ("asset:read", "View assets"),
    ("asset:write", "Create and edit assets"),
    ("asset:delete", "Delete or retire assets"),
    ("assignment:write", "Assign and reassign assets"),
    ("scan:read", "View scan data and discovered devices"),
    ("scan:write", "Trigger and configure scans"),
    ("ingest:write", "Ingest scan data (service accounts)"),
    ("report:read", "View reports"),
    ("audit:read", "View the audit log"),
    ("user:admin", "Manage users and roles"),
    ("org:admin", "Manage organization settings"),
]

# "*" means all permissions.
ROLES = {
    "Owner": ["*"],
    "Admin": [
        "user:admin", "asset:read", "asset:write", "asset:delete",
        "assignment:write", "scan:read", "scan:write", "report:read",
        "audit:read",
    ],
    "Technician": ["asset:read", "asset:write", "assignment:write", "scan:read"],
    "Auditor": ["asset:read", "scan:read", "report:read", "audit:read"],
    "Viewer": ["asset:read", "report:read"],
    "service:collector": ["ingest:write", "asset:read"],
}


class Command(BaseCommand):
    help = "Seed default permissions and system roles."

    @transaction.atomic
    def handle(self, *args, **options):
        perms: dict[str, Permission] = {}
        for code, desc in PERMISSIONS:
            perm, _ = Permission.objects.update_or_create(
                code=code, defaults={"description": desc}
            )
            perms[code] = perm
        self.stdout.write(self.style.SUCCESS(f"Permissions: {len(perms)} ensured"))

        all_perms = list(perms.values())
        for name, codes in ROLES.items():
            role, _ = Role.objects.get_or_create(
                name=name, defaults={"is_system": True}
            )
            role.is_system = True
            role.save(update_fields=["is_system"])
            granted = all_perms if codes == ["*"] else [perms[c] for c in codes]
            role.permissions.set(granted)
            self.stdout.write(
                f"  role {name}: {len(granted)} permissions"
            )
        self.stdout.write(self.style.SUCCESS(f"Roles: {len(ROLES)} ensured"))
