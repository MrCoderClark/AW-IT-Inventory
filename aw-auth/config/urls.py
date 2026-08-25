"""URL configuration for the aw-auth service."""

from django.contrib import admin
from django.http import JsonResponse
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView


def healthz(_request):
    return JsonResponse({"status": "ok", "service": "aw-auth"})


urlpatterns = [
    path("admin/", admin.site.urls),
    path("healthz", healthz, name="healthz"),
    path("v1/auth/", include("accounts.urls")),
    path("v1/schema", SpectacularAPIView.as_view(), name="schema"),
    path("v1/docs", SpectacularSwaggerView.as_view(url_name="schema"), name="docs"),
]
