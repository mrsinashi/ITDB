"""merge branches

Revision ID: 7565095a2679
Revises: 794759cf9748, a7f3c2d91e04
Create Date: 2026-09-25 12:03:47.172324

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7565095a2679'
down_revision: Union[str, Sequence[str], None] = ('794759cf9748', 'a7f3c2d91e04')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
