"""The architecture IR, as Pydantic models generated from the JSON Schema.

`models.py` is generated from `packages/ir-schema/schema/architecture-ir.schema.json`
and must not be hand-edited; Gate 4 regenerates it and fails on any diff. This
module is the hand-written surface over it, holding only what the generator has
no way to express.

One fidelity note worth knowing before trusting a parse. The schema forbids
unknown properties on a node through `unevaluatedProperties`, which
`datamodel-code-generator` does not implement, so the node models here ignore an
unknown key where the schema would reject the document. Nested parameter objects
and the document root do forbid extras, and the authority remains `validateIr`
in `@infracanvas/ir-schema`, which every document crosses on its way in.
"""

from typing import Annotated

from pydantic import Field, TypeAdapter

from brain.ir.models import (
    ArchitectureIr,
    Edge,
    Layout,
    NodeBase,
    PendingContractNode,
    Presentation,
    SubnetNode,
    SubnetParams,
    Viewport,
    VpcNode,
    VpcParams,
)

#: The node union, tagged by ``kind``. Pydantic dispatches on the discriminator
#: instead of trying each branch, so a bad parameter reports the branch it
#: belongs to rather than three failures the reader has to choose between.
IrNode = Annotated[VpcNode | SubnetNode | PendingContractNode, Field(discriminator="kind")]

IrNodeAdapter: TypeAdapter[VpcNode | SubnetNode | PendingContractNode] = TypeAdapter(IrNode)

__all__ = [
    "ArchitectureIr",
    "Edge",
    "IrNode",
    "IrNodeAdapter",
    "Layout",
    "NodeBase",
    "PendingContractNode",
    "Presentation",
    "SubnetNode",
    "SubnetParams",
    "Viewport",
    "VpcNode",
    "VpcParams",
]
