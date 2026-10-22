import importlib.util
import json
import pathlib

import pytest

spec = importlib.util.spec_from_file_location(
    "vpn_watch", pathlib.Path(__file__).parents[1] / "scripts/vpn/vpn_watch.py")
vw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vw)

l2tp_spec = importlib.util.spec_from_file_location(
    "l2tp_spi_t", pathlib.Path(__file__).parents[1] / "scripts/vpn/l2tp.py")
l2tp = importlib.util.module_from_spec(l2tp_spec)
l2tp_spec.loader.exec_module(l2tp)

# Synthetic SPI values only (generic example data, never copied from a run log).
IKE_I = "0123456789abcdef"
IKE_R = "fedcba9876543210"
ESP_I = "c1234567"
ESP_O = "c7654321"


def test_mask_removes_addresses_and_ids():
    s = "sending to 203.0.113.7[500] host vpn.example.com id 'alice' psk=abc123 SPIs 1a2b3c4d_i fe80::1 aa:bb:cc:dd:ee:ff"
    out = vw.mask(s)
    for leak in ("203.0.113.7", "vpn.example.com", "alice", "abc123", "1a2b3c4d", "fe80::1", "aa:bb:cc"):
        assert leak not in out


def test_event_filter_keeps_rekey_and_dpd_only():
    lines = ["15[IKE] sending DPD request to 1.2.3.4", "00[LIB] loaded plugins: aes", "09[CHD] rekeying CHILD_SA"]
    out = vw.filter_events(lines)
    assert len(out) == 2 and all("1.2.3.4" not in x for x in out)


def test_status_filter_masks():
    t = "mavat[1]: ESTABLISHED 12 minutes ago, 10.0.0.5[x]...203.0.113.7[y]\nnoise line"
    out = vw.filter_status(t)
    assert out and "203.0.113.7" not in out[0] and "10.0.0.5" not in out[0]


def test_mask_redacts_ike_responder_spi_issue_120():
    # Issue #120: the `ipsec statusall` IKE line printed as
    # "IKEv1 SPI <spi>* <responder>_r" - the responder SPI stayed in clear
    # because the 16-hex form never matched (no \b between hex and "_").
    line = f"mavat-l2tp[1]: IKEv1 SPIs: {IKE_I}_i* {IKE_R}_r, pre-shared key reauthentication in 2 hours"
    out = vw.mask(line)
    assert IKE_I not in out and IKE_R not in out
    assert out == "mavat-l2tp[1]: IKEv1 SPIs: <spi>* <spi>, pre-shared key reauthentication in 2 hours"


@pytest.mark.parametrize("spi", [ESP_I, IKE_R, IKE_R.upper()])
@pytest.mark.parametrize("role", ["i", "o", "r"])
@pytest.mark.parametrize("tail", ["", "*", ",", " and TS"])
def test_mask_redacts_8_and_16_hex_spis_for_every_role(spi, role, tail):
    out = vw.mask(f"CHILD_SA mavat-l2tp{{1}} established with SPIs {spi}_{role}{tail}")
    assert spi not in out and spi.lower() not in out.lower()
    assert "<spi>" in out


def test_mask_redacts_responder_spi_without_spi_keyword():
    # The responder SPI is often the second value on the line, after the
    # keyword-anchored first one, so it must be caught on its own.
    out = vw.mask(f"sending DELETE for IKE_SA mavat-l2tp[1] {IKE_I}_i {IKE_R}_r")
    assert IKE_I not in out and IKE_R not in out
    out = vw.mask(f"ESP SPIs: {ESP_I}_i {ESP_O}_o {ESP_O}_r")
    assert ESP_I not in out and ESP_O not in out


def test_mask_redacts_bare_spi_after_keyword_and_long_hex_next_to_underscore():
    for line in (f"received DELETE for ESP CHILD_SA with SPI {ESP_O}",
                 f"received DELETE for ESP CHILD_SA with SPI 0x{ESP_O}",
                 f"rekeying, spi={IKE_R}_r"):
        assert ESP_O not in vw.mask(line) and IKE_R not in vw.mask(line)
    assert vw.mask(f"cookie {IKE_R}_x") == "cookie <hex>_x"


def test_mask_keeps_non_spi_words():
    line = "09[CHD] rekeying CHILD_SA, SPI deleted, ESTABLISHED 12 minutes ago"
    assert vw.mask(line) == line


def test_event_and_status_filters_redact_responder_spi():
    events = vw.filter_events([f"12[IKE] deleting IKE_SA mavat-l2tp[1] SPIs {IKE_I}_i {IKE_R}_r"])
    status = vw.filter_status(f"mavat-l2tp[1]: ESTABLISHED 3 minutes ago, IKEv1 SPIs: {IKE_I}_i* {IKE_R}_r")
    for out in (events, status):
        assert out and IKE_I not in out[0] and IKE_R not in out[0]


def test_l2tp_negotiation_summary_never_carries_spis():
    # The charon summarizer in l2tp.py (checked for #120) emits fixed
    # categories only, so SPIs in raw daemon text cannot reach the log.
    text = (f"12[IKE] IKE_SA mavat-l2tp[1] established, SPIs {IKE_I}_i {IKE_R}_r\n"
            f"13[IKE] CHILD_SA mavat-l2tp{{1}} established with SPIs {ESP_I}_i {ESP_O}_o\n"
            f"generating QUICK_MODE request 1 SPI {ESP_O}\nparsed QUICK_MODE response 1")
    summary = json.dumps(l2tp.summarize_negotiation(text))
    for spi in (IKE_I, IKE_R, ESP_I, ESP_O):
        assert spi not in summary
    assert "ike_established" in summary and "child_established" in summary
