import warnings

import pytest
from shapely.geometry import Point, shape

from ginot.mapdata import feature_collection, plan_geometry


def square(x, y, width):
    return [[x, y], [x + width, y], [x + width, y + width], [x, y + width], [x, y]]


def test_itm_projection_and_representative_point():
    result = plan_geometry([square(220000, 630000, 100)])
    lng, lat = result["point"]
    assert 35 < lng < 36 and 31 < lat < 32
    assert shape(result["geometry"]).covers(Point(lng, lat))


def test_hole_and_multipart_survive_projection():
    result = plan_geometry(
        [
            square(220000, 630000, 1000),
            square(220200, 630200, 300),
            square(222000, 632000, 50),
        ]
    )
    geometry = shape(result["geometry"])
    assert geometry.geom_type == "MultiPolygon"
    assert sum(len(p.interiors) for p in geometry.geoms) == 1
    assert geometry.covers(Point(*result["point"]))


def test_missing_and_invalid_geometry_are_not_geocoded():
    assert plan_geometry([]) is None
    with pytest.raises(ValueError):
        plan_geometry([[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]])
    data = feature_collection([{"attributes": {"pl_number": "synthetic"}}])
    assert data["missing_geometry"] == 1
    assert data["features"] == []


def test_only_public_fields_are_copied():
    data = feature_collection(
        [
            {
                "attributes": {
                    "pl_number": "synthetic",
                    "owner_email": "private@example.invalid",
                },
                "geometry": {"rings": [square(220000, 630000, 100)]},
            }
        ]
    )
    assert "owner_email" not in data["features"][0]["properties"]
    assert len(data["features"]) == 1


def test_plan_geometry_raises_no_shapely_deprecation_warning():
    """Issue #330: shapely.ops.transform() is deprecated in shapely 2.2+.

    Scoped to shapely's own DeprecationWarning (matching pytest.ini's
    `filterwarnings = error::DeprecationWarning:shapely`): escalating every
    DeprecationWarning here, including ones from other libraries' older
    numpy usage on Python 3.10, fails for a reason unrelated to this issue.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        warnings.filterwarnings(
            "error", category=DeprecationWarning, module=r"shapely(\.|$)"
        )
        result = plan_geometry([square(220000, 630000, 100)])
    assert result is not None
