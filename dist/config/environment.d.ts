export interface ApiEnvironment {
    nodeEnv: string;
    host: string;
    port: number;
    webOrigin?: string;
    version: string;
}
export declare const readEnvironment: () => ApiEnvironment;
export declare const environment: ApiEnvironment;
