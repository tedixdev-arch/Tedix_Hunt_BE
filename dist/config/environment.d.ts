export interface ApiEnvironment {
    nodeEnv: string;
    host: string;
    port: number;
    webOrigin?: string;
    mongoUri?: string;
    jwtSecret: string;
    jwtExpiresIn: string;
    refreshTokenExpiresIn: string;
    version: string;
}
export declare const readEnvironment: () => ApiEnvironment;
export declare const environment: ApiEnvironment;
