from django.db import models


class Permission(models.Model):
    """A granular, app-namespaced permission, e.g. ``asset:read``.

    Distinct from Django's built-in auth Permission — these are the codes
    embedded in access-token claims and enforced by client apps.
    """

    code = models.CharField(max_length=100, unique=True)
    description = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["code"]

    def __str__(self) -> str:
        return self.code


class Role(models.Model):
    """A named bundle of permissions assigned to users."""

    name = models.CharField(max_length=64, unique=True)
    description = models.CharField(max_length=255, blank=True)
    is_system = models.BooleanField(
        default=False,
        help_text="Seeded, protected role that ships with the system.",
    )
    permissions = models.ManyToManyField(
        Permission, related_name="roles", blank=True
    )

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name
