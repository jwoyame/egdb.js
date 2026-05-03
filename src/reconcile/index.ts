/**
 * Reconcile/Post module for enterprise geodatabase versioning
 *
 * This module provides functions for:
 * - Finding common ancestors between versions
 * - Detecting changes in version states
 * - Detecting and resolving conflicts
 * - Applying changes during reconcile
 * - Posting changes to parent versions
 * - Compressing versioned tables
 */

// State lineage helpers
export {
  findCommonAncestor,
  getStatesInRange,
  getLineageName,
  addStatesToLineage,
} from './find-ancestor';

// Change detection
export {
  getTableChanges,
  getAllChanges,
  getChangesSummary,
} from './get-changes';

// Row data reading
export {
  readATableRow,
  readBaseTableRow,
  readRowAtState,
  normalizeRow,
} from './read-row-data';

// Conflict detection
export {
  compareRows,
  detectConflicts,
  detectDetailedConflicts,
  getConflictsSummary,
} from './detect-conflicts';

// Apply changes
export {
  copyATableRow,
  insertDeleteMarker,
  removeFromATable,
  removeFromDTable,
  applyMergedRow,
  applyParentChanges,
} from './apply-changes';

// Post operations
export {
  isReconciled,
  postChangesToParent,
  updateVersionState,
  deleteStates,
  getChildUniqueStates,
} from './post';

// Compression
export {
  compressStates,
  removeOrphanedStates,
  getVersionStats,
} from './compress';

// State management (EditSession isolation)
export {
  createChildState,
  deleteChildState,
  acquireStateLock,
  releaseStateLock,
  getLockedStateIds,
  cleanupStaleLocks,
  InsufficientPrivilegeError,
} from './state-management';
export type { StaleLockCleanupResult } from './state-management';
