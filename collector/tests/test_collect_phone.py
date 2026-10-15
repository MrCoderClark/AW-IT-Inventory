"""Tests for the credential-free phone identity read (spec 27, phase 1).

The MAC comes from the TLS cert CN and the Yealink confirmation from the issuer, so
`parse_cert` is exercised against certs generated in-memory (subject CN = MAC, issuer
org = vendor). The pure helpers use the real recon values from 192.168.75.62.
"""

from __future__ import annotations

import datetime

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from collect_phone import model_from_title, normalize_mac, parse_cert


def _cert(cn: str, org: str) -> str:
    """A minimal self-signed cert PEM with the given CN + organization (issuer ==
    subject), standing in for a device cert."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, cn),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, org),
        ]
    )
    now = datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now.replace(year=2030))
        .sign(key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.PEM).decode()


def test_normalize_mac():
    assert normalize_mac("805e0c034323") == "80:5E:0C:03:43:23"  # the real cert CN
    assert normalize_mac("80:5e:0c:03:43:23") == "80:5E:0C:03:43:23"
    assert normalize_mac("80-5e-0c-03-43-23") == "80:5E:0C:03:43:23"
    assert normalize_mac("not-a-mac") is None
    assert normalize_mac("") is None


def test_model_from_title():
    assert model_from_title("<title>Yealink T54W Phone</title>") == "Yealink T54W"
    assert model_from_title("<TITLE> Yealink  T46S  Phone </TITLE>") == "Yealink T46S"
    assert model_from_title("<title>Login</title>") == "Login"
    assert model_from_title("no title here") is None


def test_parse_cert_yealink():
    pem = _cert("805e0c034323", "Yealink Network Technology Co.,Ltd.")
    mac, is_yealink = parse_cert(pem)
    assert mac == "80:5E:0C:03:43:23"
    assert is_yealink is True


def test_parse_cert_non_yealink_is_ignored():
    # A MAC-shaped CN but a non-Yealink issuer must NOT classify as a phone.
    mac, is_yealink = parse_cert(_cert("805e0c034323", "Acme Devices Inc"))
    assert is_yealink is False


def test_classify_phone_candidate_and_priority():
    from config import Config
    from discovery import classify

    cfg = Config()  # default ports: winrm 5985, smb 445, printer 9100, phone 443
    assert classify([443], cfg) == "phone"
    assert classify([5985], cfg) == "windows"
    assert classify([9100], cfg) == "printer"
    # Windows / printer win over a co-open 443, so a server isn't misread as a phone.
    assert classify([443, 5985], cfg) == "windows"
    assert classify([443, 9100], cfg) == "printer"
    assert classify([80], cfg) == "unknown"
