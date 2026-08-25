from django.contrib import admin

from .models import Permission, Role


@admin.register(Permission)
class PermissionAdmin(admin.ModelAdmin):
    list_display = ("code", "description")
    search_fields = ("code", "description")


@admin.register(Role)
class RoleAdmin(admin.ModelAdmin):
    list_display = ("name", "description", "is_system")
    list_filter = ("is_system",)
    search_fields = ("name",)
    filter_horizontal = ("permissions",)
