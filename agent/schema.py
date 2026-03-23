from __future__ import annotations

from typing import Any, Dict, List

from pydantic import BaseModel, Field


class Action(BaseModel):
    tool: str
    args: Dict[str, Any] = Field(default_factory=dict)


class Plan(BaseModel):
    steps: List[Action]

