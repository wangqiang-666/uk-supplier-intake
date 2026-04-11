let runtime = null;
export function setWeComRuntime(r) {
    runtime = r;
}
export function getWeComRuntime() {
    if (!runtime) {
        throw new Error("WeCom runtime not initialized - plugin not registered");
    }
    return runtime;
}
