/**
 * Materialise a reference-model `Fabric` into the synthetic SQL Server schema,
 * and read pieces of the DB back for assertions. The same model that seeds the
 * DB is the one `compressRef` runs on, so a test can compare the two.
 */
import type { IDatabaseConnection } from '../../src/connections/connection';
import { Fabric, type StateId, type Oid } from './reference-model';
import { REG_ID } from './db';

/** Model table name → the synthetic base/a/D tables (regId 18). */
export const MODEL_TABLE = 'parcels';

/** Write every model row into the (freshly reset) scratch DB. */
export async function materialize(conn: IDatabaseConnection, f: Fabric): Promise<void> {
  // states (0 already inserted by resetFabric)
  for (const s of f.states.values()) {
    if (s.stateId === 0) continue;
    await conn.execute(
      `INSERT INTO sde.SDE_states (state_id, owner, lineage_name, parent_state_id) VALUES (@p0, 'test', @p1, @p2);`,
      [s.stateId, s.lineageName, s.parentStateId],
    );
  }
  // closure (skip (0,0) already present)
  for (const key of f.lineages) {
    if (key === '0:0') continue;
    const [ln, lid] = key.split(':').map(Number);
    await conn.execute(
      `INSERT INTO sde.SDE_state_lineages (lineage_name, lineage_id) VALUES (@p0, @p1);`, [ln, lid]);
  }
  // versions
  let vi = 0;
  for (const [name, tip] of f.versions) {
    await conn.execute(
      `INSERT INTO sde.SDE_versions (name, owner, state_id) VALUES (@p0, 'test', @p1);`, [name || `v${vi++}`, tip]);
  }
  // locks
  let li = 1;
  for (const st of f.locks) {
    await conn.execute(
      `INSERT INTO sde.SDE_state_locks (sde_id, state_id) VALUES (@p0, @p1);`, [li++, st]);
  }
  // data (single model table → base18/a18/D18)
  const t = f.tables.get(MODEL_TABLE);
  if (t) {
    for (const [oid, r] of t.base) {
      await conn.execute(`INSERT INTO dbo.base${REG_ID} (OBJECTID, VAL) VALUES (@p0, @p1);`, [oid, val(r)]);
    }
    for (const a of t.adds.values()) {
      await conn.execute(`INSERT INTO dbo.a${REG_ID} (OBJECTID, SDE_STATE_ID, VAL) VALUES (@p0, @p1, @p2);`,
        [a.oid, a.state, val(a.values)]);
    }
    for (const d of t.dels) {
      await conn.execute(`INSERT INTO dbo.D${REG_ID} (SDE_DELETES_ROW_ID, SDE_STATE_ID, DELETED_AT) VALUES (@p0, @p1, @p2);`,
        [d.oid, d.state, d.deletedAt]);
    }
  }
}

const val = (r: Record<string, unknown>) => (r.VAL == null ? null : String(r.VAL));

// --- read-back helpers ------------------------------------------------------

export async function liveStateIds(conn: IDatabaseConnection): Promise<Set<StateId>> {
  const rows = await conn.query<{ state_id: number | bigint }>(`SELECT state_id FROM sde.SDE_states;`);
  return new Set(rows.map(r => Number(r.state_id)));
}

export async function parentOf(conn: IDatabaseConnection, state: StateId): Promise<StateId | undefined> {
  const rows = await conn.query<{ parent_state_id: number | bigint }>(
    `SELECT parent_state_id FROM sde.SDE_states WHERE state_id = @p0;`, [state]);
  return rows.length ? Number(rows[0]!.parent_state_id) : undefined;
}

export async function aRowsAt(conn: IDatabaseConnection, state: StateId): Promise<Array<{ oid: Oid; val: string | null }>> {
  const rows = await conn.query<{ OBJECTID: number; VAL: string | null }>(
    `SELECT OBJECTID, VAL FROM dbo.a${REG_ID} WHERE SDE_STATE_ID = @p0 ORDER BY OBJECTID;`, [state]);
  return rows.map(r => ({ oid: Number(r.OBJECTID), val: r.VAL }));
}

/** Every non-zero parent_state_id that does not resolve to a live state. */
export async function danglingParents(conn: IDatabaseConnection): Promise<StateId[]> {
  const rows = await conn.query<{ state_id: number | bigint }>(
    `SELECT s.state_id FROM sde.SDE_states s
      WHERE s.parent_state_id <> 0
        AND NOT EXISTS (SELECT 1 FROM sde.SDE_states p WHERE p.state_id = s.parent_state_id);`);
  return rows.map(r => Number(r.state_id));
}
