from fastapi import APIRouter
from sqlalchemy import func

from db import SessionLocal
from models import Computer, Location

router = APIRouter(prefix="/api", tags=["locations"])


@router.get("/locations/tree")
def locations_tree():
    session = SessionLocal()

    try:
        locations = (
            session.query(Location)
            .filter(Location.archived == False)
            .all()
        )

        computer_counts = (
            session.query(Computer.location_id, func.count(Computer.id))
            .group_by(Computer.location_id)
            .all()
        )

        direct_counts = {}

        for location_id, count in computer_counts:
            if location_id is not None:
                direct_counts[location_id] = count

        unlocated = (
            session.query(func.count(Computer.id))
            .filter(Computer.location_id.is_(None))
            .scalar()
        ) or 0

        nodes = {}

        for location in locations:
            nodes[location.id] = {
                "id": location.id,
                "parent_id": location.parent_id,
                "kind": location.kind,
                "name": location.name,
                "code": location.code,
                "sort": location.sort or 0,
                "direct_count": direct_counts.get(location.id, 0),
                "total_count": 0,
                "children": [],
            }

        for node in nodes.values():
            parent_id = node["parent_id"]

            if parent_id and parent_id in nodes:
                nodes[parent_id]["children"].append(node)

        roots = [node for node in nodes.values() if node["parent_id"] is None or node["parent_id"] not in nodes]

        def sort_nodes(node):
            node["children"].sort(
                key=lambda item: (
                    item["sort"],
                    (item["name"] or "").lower(),
                )
            )

            for child in node["children"]:
                sort_nodes(child)

        def calculate_totals(node):
            total = node["direct_count"]

            for child in node["children"]:
                total += calculate_totals(child)

            node["total_count"] = total

            return total

        roots.sort(
            key=lambda item: (
                item["sort"],
                (item["name"] or "").lower(),
            )
        )

        for root in roots:
            sort_nodes(root)
            calculate_totals(root)

        return {
            "roots": roots,
            "unlocated": unlocated,
        }

    finally:
        session.close()