from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from rbac.models import Role

User = get_user_model()


class UserSerializer(serializers.ModelSerializer):
    roles = serializers.SlugRelatedField(
        slug_field="name", many=True, read_only=True
    )
    permissions = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id",
            "email",
            "full_name",
            "is_active",
            "is_staff",
            "mfa_enabled",
            "date_joined",
            "roles",
            "permissions",
        ]
        read_only_fields = fields

    def get_permissions(self, obj) -> list[str]:
        return sorted(obj.get_permission_codes())


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(
        write_only=True, style={"input_type": "password"},
        validators=[validate_password],
    )

    class Meta:
        model = User
        fields = ["id", "email", "full_name", "password"]
        read_only_fields = ["id"]

    def create(self, validated_data):
        user = User.objects.create_user(**validated_data)
        # New self-serve users get the least-privilege Viewer role if seeded.
        try:
            user.roles.add(Role.objects.get(name="Viewer"))
        except Role.DoesNotExist:
            pass
        return user


class OpusTokenObtainPairSerializer(TokenObtainPairSerializer):
    """Embeds identity + RBAC claims so client apps can authorize locally."""

    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        token["email"] = user.email
        token["roles"] = list(user.roles.values_list("name", flat=True))
        token["perms"] = sorted(user.get_permission_codes())
        return token
