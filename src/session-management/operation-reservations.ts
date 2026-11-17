import type Database from 'better-sqlite3';
/** Only unfinished mutations in this manager, never another process's occupancy. */
function pending(db: Database.Database, table: 'rename_requests' | 'delete_requests') {
  return (db.prepare('SELECT data FROM ' + table).all() as { data: string }[])
    .map((r) => JSON.parse(r.data))
    .filter((o) => ['pending', 'uncertain'].includes(o.outcome.state));
}
export const pendingRenameIdentities = (db: Database.Database) =>
  new Set<string>(pending(db, 'rename_requests').map((o) => o.request.identity));
export const pendingDeleteIdentities = (db: Database.Database) =>
  new Set<string>(pending(db, 'delete_requests').map((o) => o.request.identity));
export function hasSourceReservation(
  db: Database.Database,
  identity: string,
  except?: 'rename' | 'delete',
) {
  return (
    (except !== 'rename' && pendingRenameIdentities(db).has(identity)) ||
    (except !== 'delete' && pendingDeleteIdentities(db).has(identity))
  );
}
