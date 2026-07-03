from semantic_layer.table_identifier_parser import (
    ParseTableIdentifierItem,
    parse_table_identifier_batch,
    parse_table_identifier_one,
)


def test_parse_table_identifier_supported_dialects_and_aliases() -> None:
    response = parse_table_identifier_batch(
        [
            ParseTableIdentifierItem(
                key="pg",
                sql_table_name="public.orders AS o",
                dialect="postgres",
            ),
            ParseTableIdentifierItem(
                key="bq",
                sql_table_name="analytics.orders",
                dialect="bigquery",
            ),
            ParseTableIdentifierItem(
                key="sf",
                sql_table_name="RAW.PUBLIC.ORDERS",
                dialect="snowflake",
            ),
            ParseTableIdentifierItem(
                key="athena",
                sql_table_name="analytics.orders",
                dialect="athena",
            ),
            ParseTableIdentifierItem(
                key="duckdb",
                sql_table_name="analytics.orders",
                dialect="duckdb",
            ),
        ]
    )

    assert response["pg"].ok is True
    assert response["pg"].schema_ == "public"
    assert response["pg"].name == "orders"
    assert response["pg"].canonical_table == "public.orders"
    assert response["bq"].ok is True
    assert response["bq"].schema_ == "analytics"
    assert response["bq"].name == "orders"
    assert response["sf"].ok is True
    assert response["sf"].catalog == "RAW"
    assert response["sf"].schema_ == "PUBLIC"
    assert response["sf"].name == "ORDERS"
    assert response["athena"].ok is True
    assert response["athena"].schema_ == "analytics"
    assert response["athena"].name == "orders"
    assert response["athena"].canonical_table == "analytics.orders"
    assert response["duckdb"].ok is True
    assert response["duckdb"].schema_ == "analytics"
    assert response["duckdb"].name == "orders"
    assert response["duckdb"].canonical_table == "analytics.orders"


def test_parse_table_identifier_rejects_non_physical_inputs() -> None:
    assert (
        parse_table_identifier_one("${orders.SQL_TABLE_NAME}", "postgres").reason
        == "looker_template_unresolved"
    )
    assert (
        parse_table_identifier_one("(select * from public.orders)", "postgres").reason
        == "derived_table_not_supported"
    )
    assert (
        parse_table_identifier_one(
            "public.orders join public.users on true", "postgres"
        ).reason
        == "multiple_table_references"
    )
    assert (
        parse_table_identifier_one("public.orders", "not-a-dialect").reason
        == "unsupported_dialect"
    )


def test_parse_table_identifier_preserves_batch_keys() -> None:
    response = parse_table_identifier_batch(
        [
            ParseTableIdentifierItem(
                key="z", sql_table_name="public.z", dialect="postgres"
            ),
            ParseTableIdentifierItem(
                key="a", sql_table_name="public.a", dialect="postgres"
            ),
        ]
    )

    assert list(response) == ["z", "a"]
    assert response["z"].name == "z"
    assert response["a"].name == "a"
