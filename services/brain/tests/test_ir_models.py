"""The generated Pydantic models must accept exactly what the schema accepts.

These live on the Python side because that is where both representations can be
put against the same fixtures: the JSON files in `packages/ir-schema/fixtures`
are the ones `validateIr` is tested with in TypeScript.
"""

import json
from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from brain.ir import (
    ArchitectureIr,
    IrNodeAdapter,
    PendingContractNode,
    RdsInstanceNode,
    SubnetNode,
    VpcNode,
)

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "ir-schema" / "fixtures"

# Fixtures that are invalid only because of the referential rules `validateIr`
# adds on top of the schema: an edge naming a node nobody declared, a
# containment cycle, a duplicate id. Pydantic checks the shape of a document and
# has no view on whether its graph is consistent, so it accepts these. The list
# is named rather than a bare `except`, so adding a fixture cannot silently
# widen the exemption.
REFERENTIAL_ONLY = {
    "unknown-parent.json",
    "parent-cycle.json",
    "duplicate-node-id.json",
}


def load(path: Path) -> object:
    return json.loads(path.read_text())


@pytest.mark.parametrize("fixture", sorted(FIXTURES.glob("*.json")), ids=lambda p: p.name)
def test_pydantic_accepts_every_fixture_the_schema_accepts(fixture: Path) -> None:
    document = ArchitectureIr.model_validate(load(fixture))
    assert document.provider == "aws"
    assert document.nodes


@pytest.mark.parametrize(
    "fixture", sorted((FIXTURES / "invalid").glob("*.json")), ids=lambda p: p.name
)
def test_pydantic_rejects_every_fixture_the_schema_rejects(fixture: Path) -> None:
    if fixture.name in REFERENTIAL_ONLY:
        pytest.skip("invalid only under the referential rules, which are not a shape check")
    with pytest.raises(ValidationError):
        ArchitectureIr.model_validate(load(fixture))


def test_pydantic_rejects_an_unknown_top_level_key() -> None:
    document = load(FIXTURES / "minimal.json")
    assert isinstance(document, dict)
    with pytest.raises(ValidationError):
        ArchitectureIr.model_validate({**document, "budget": 100})


def test_camel_case_and_snake_case_field_names_both_parse() -> None:
    """The wire format is camelCase; the brain's own code reads PEP 8."""
    minimal = load(FIXTURES / "minimal.json")
    assert isinstance(minimal, dict)
    from_wire = ArchitectureIr.model_validate(minimal)
    # Read from the fixture rather than pinned, so a schema version bump is not
    # a test edit in a file that has nothing to say about versioning.
    assert from_wire.ir_version == minimal["irVersion"]

    by_field_name = ArchitectureIr.model_validate(
        {
            "ir_version": minimal["irVersion"],
            "name": "Minimal",
            "provider": "aws",
            "region": "eu-west-1",
            "nodes": [
                {
                    "id": "vpc-main",
                    "kind": "vpc",
                    "name": "Main VPC",
                    "params": {"cidr_block": "10.0.0.0/16"},
                }
            ],
            "edges": [],
        }
    )
    assert by_field_name == from_wire


def test_the_node_union_dispatches_on_kind() -> None:
    node = IrNodeAdapter.validate_python(
        {
            "id": "vpc-main",
            "kind": "vpc",
            "name": "Main VPC",
            "params": {"cidrBlock": "10.0.0.0/16"},
        }
    )
    assert isinstance(node, VpcNode)
    assert node.params.cidr_block == "10.0.0.0/16"


def test_a_node_carrying_another_kinds_parameters_is_rejected() -> None:
    with pytest.raises(ValidationError):
        IrNodeAdapter.validate_python(
            {
                "id": "subnet-a",
                "kind": "subnet",
                "name": "A",
                "params": {"cidrBlock": "10.0.0.0/16"},
            }
        )


def test_every_resource_kind_in_the_schema_appears_in_the_generated_union() -> None:
    schema = json.loads((FIXTURES.parent / "schema" / "architecture-ir.schema.json").read_text())

    covered: set[str] = set()
    for model in (VpcNode, SubnetNode, RdsInstanceNode, PendingContractNode):
        covered |= set(get_args(model.model_fields["kind"].annotation))

    assert covered == set(schema["$defs"]["resourceKind"]["enum"])
