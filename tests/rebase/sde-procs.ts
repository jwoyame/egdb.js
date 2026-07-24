/**
 * Synthetic ArcSDE state procs for the rebase harness.
 *
 * The compress harness never needs these: its `Grower` reimplements
 * `SDE_state_new_edit` in TypeScript to grow the *model*, then `materialize`
 * dumps the finished tree into the DB — no state is ever created at runtime.
 *
 * `rebaseVersion` is different: it CREATES a state at runtime via
 * `createChildState`, which calls `sde.SDE_get_primary_oid`,
 * `sde.SDE_get_current_user_name` and `sde.SDE_state_new_edit`. Those procs do
 * not exist in the synthetic schema, so we provide them here — replicating the
 * exact lineage-allocation rule that `Grower.newEdit` implements and that
 * `tier2-conformance.test.ts` validates against the REAL proc. Keeping this in
 * lockstep with `Grower.newEdit` is what keeps the rebase harness honest; if the
 * two ever diverge, tier-2 conformance is the referee.
 */

import type { IDatabaseConnection } from '../../src/connections/connection';

export async function installRebaseProcs(conn: IDatabaseConnection): Promise<void> {
  // One shared id pool. Real ArcSDE draws state ids, connection ids and
  // lineage_names from the same object-id pool, so a single monotonic counter is
  // both faithful and collision-free by construction.
  await conn.execute(`
    IF OBJECT_ID('sde.harness_id_pool') IS NULL
      CREATE TABLE sde.harness_id_pool (k INT NOT NULL PRIMARY KEY, next_id BIGINT NOT NULL);`);

  await conn.execute(`
    CREATE OR ALTER PROCEDURE sde.SDE_get_primary_oid @id_type INT, @cnt INT, @id BIGINT OUTPUT AS
    BEGIN
      SET NOCOUNT ON;
      UPDATE sde.harness_id_pool SET @id = next_id, next_id = next_id + @cnt WHERE k = 0;
    END`);

  await conn.execute(`
    CREATE OR ALTER PROCEDURE sde.SDE_get_current_user_name @usr NVARCHAR(128) OUTPUT AS
    BEGIN SET @usr = N'test'; END`);

  // Mirrors Grower.newEdit (op-model.ts):
  //   - parent 0, or a parent that already has children -> BRANCH: allocate a
  //     fresh lineage_name, copy the parent's closure under it, add self.
  //   - a childless non-base parent -> LINEAR: reuse the parent's lineage_name,
  //     just add self to the closure. (states_cuk stays satisfiable: the parent's
  //     own row keys on the grandparent, so (parent, lineage_name) is unique.)
  await conn.execute(`
    CREATE OR ALTER PROCEDURE sde.SDE_state_new_edit
      @newState BIGINT, @usr NVARCHAR(128), @parent BIGINT,
      @lineage BIGINT OUTPUT, @conn INT, @crt DATETIME OUTPUT
    AS
    BEGIN
      SET NOCOUNT ON;
      DECLARE @parentLineage BIGINT, @childCount INT;
      SELECT @parentLineage = lineage_name FROM sde.SDE_states WHERE state_id = @parent;
      SELECT @childCount = COUNT(*) FROM sde.SDE_states WHERE parent_state_id = @parent;
      IF @parent <> 0 AND @childCount = 0
      BEGIN
        SET @lineage = @parentLineage;
        INSERT INTO sde.SDE_state_lineages (lineage_name, lineage_id) VALUES (@lineage, @newState);
      END
      ELSE
      BEGIN
        EXEC sde.SDE_get_primary_oid 10, 1, @lineage OUTPUT;
        INSERT INTO sde.SDE_state_lineages (lineage_name, lineage_id)
          SELECT @lineage, lineage_id FROM sde.SDE_state_lineages WHERE lineage_name = @parentLineage;
        INSERT INTO sde.SDE_state_lineages (lineage_name, lineage_id) VALUES (@lineage, @newState);
      END
      INSERT INTO sde.SDE_states (state_id, owner, lineage_name, parent_state_id)
        VALUES (@newState, @usr, @lineage, @parent);
      -- Real SDE_state_new_edit places an exclusive state lock; rebaseVersion
      -- clears it right after. Faithful to place it here.
      INSERT INTO sde.SDE_state_locks (sde_id, state_id) VALUES (@conn, @newState);
      SET @crt = GETUTCDATE();
    END`);
}

/**
 * Seed the id pool ABOVE every id already present, so a runtime `newEdit` cannot
 * collide with a materialized state id or lineage_name. Call after `materialize`,
 * before any operation that creates a state.
 */
export async function seedIdPool(conn: IDatabaseConnection): Promise<void> {
  const rows = await conn.query<{ hi: number | bigint | null }>(`
    SELECT MAX(v) AS hi FROM (
      SELECT state_id AS v FROM sde.SDE_states
      UNION ALL SELECT lineage_name FROM sde.SDE_states
      UNION ALL SELECT lineage_name FROM sde.SDE_state_lineages
      UNION ALL SELECT lineage_id FROM sde.SDE_state_lineages
    ) x;`);
  const start = Number(rows[0]?.hi ?? 0) + 1000; // gap so ids are visually distinct
  await conn.execute(`DELETE FROM sde.harness_id_pool;`);
  await conn.execute(`INSERT INTO sde.harness_id_pool (k, next_id) VALUES (0, @p0);`, [start]);
}
