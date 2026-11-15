// Types for core/kernel/open-migrate.mjs (docs/architecture.md section 18).
export declare function needsMigration(foundation: any, file: any): boolean;
export declare function migrateOnOpen<F extends object>(foundation: any, file: F): Promise<{file: F; migrated: boolean; from: number | null; error: string | null}>;
export declare function isUpgrade(prev: any, next: any): boolean;
