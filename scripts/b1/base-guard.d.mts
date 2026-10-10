export function assertBaseEnvironment(env?:NodeJS.ProcessEnv):void;
export function baseMigrationFiles(files:string[],options?:{only?:readonly string[];exclude?:readonly string[]}):string[];
export function assertBaseTarget(db:{query:(text:string)=>Promise<{rows:Record<string,unknown>[]}>},env?:NodeJS.ProcessEnv):Promise<void>;
