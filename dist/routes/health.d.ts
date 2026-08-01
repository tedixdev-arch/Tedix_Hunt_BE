export interface HealthResponse {
    status: 'ok';
    service: string;
    timestamp: string;
    version: string;
}
export declare const healthRouter: import("express-serve-static-core").Router;
