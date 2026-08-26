import secrets
import uuid

from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.contrib.auth.models import (
    AbstractBaseUser,
    BaseUserManager,
    PermissionsMixin,
)
from django.db import models
from django.utils import timezone


class UserManager(BaseUserManager):
    """Manager for the email-based User model."""

    use_in_migrations = True

    def _create_user(self, email, password, **extra):
        if not email:
            raise ValueError("Users must have an email address.")
        email = self.normalize_email(email)
        user = self.model(email=email, **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra):
        extra.setdefault("is_staff", False)
        extra.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra)

    def create_superuser(self, email, password=None, **extra):
        extra.setdefault("is_staff", True)
        extra.setdefault("is_superuser", True)
        if extra.get("is_staff") is not True:
            raise ValueError("Superuser must have is_staff=True.")
        if extra.get("is_superuser") is not True:
            raise ValueError("Superuser must have is_superuser=True.")
        return self._create_user(email, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    """Email-first user. Authorization is driven by :class:`rbac.Role`."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(unique=True)
    full_name = models.CharField(max_length=150, blank=True)

    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    mfa_enabled = models.BooleanField(default=False)
    date_joined = models.DateTimeField(auto_now_add=True)

    roles = models.ManyToManyField("rbac.Role", related_name="users", blank=True)

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS: list[str] = ["full_name"]

    class Meta:
        ordering = ["email"]

    def __str__(self) -> str:
        return self.email

    def get_permission_codes(self) -> set[str]:
        """Effective permission codes across all assigned roles.

        Superusers implicitly hold every permission.
        """
        from rbac.models import Permission

        if self.is_superuser:
            return set(Permission.objects.values_list("code", flat=True))
        codes = self.roles.values_list("permissions__code", flat=True)
        return {c for c in codes if c}


class ServiceAccount(models.Model):
    """A machine identity (e.g. the collector) authenticating via the
    client-credentials grant. Holds scopes instead of user roles."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=150)
    client_id = models.CharField(max_length=64, unique=True)
    secret_hash = models.CharField(max_length=255)
    scopes = models.JSONField(default=list)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="service_accounts",
    )
    expires_at = models.DateTimeField(null=True, blank=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    disabled_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.name} ({self.client_id})"

    @property
    def is_active(self) -> bool:
        if self.disabled_at:
            return False
        if self.expires_at and self.expires_at < timezone.now():
            return False
        return True

    def set_secret(self, raw: str) -> None:
        self.secret_hash = make_password(raw)

    def check_secret(self, raw: str) -> bool:
        return check_password(raw, self.secret_hash)

    @staticmethod
    def new_client_id() -> str:
        return "svc_" + secrets.token_hex(8)

    @staticmethod
    def new_secret() -> str:
        return secrets.token_urlsafe(32)
