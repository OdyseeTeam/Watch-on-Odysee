// Deprecated dialog component. Keep no-op stubs so imports do not fail.
export type DialogManager = {
    useAlerts(): Record<string, unknown>
    alert(message: string): Promise<void>
    prompt(message: string): Promise<string | null>
    confirm(message: string): Promise<boolean>
}

export function createDialogManager(): DialogManager {
    return {
        useAlerts() { return {} },
        async alert() { },
        async prompt() { return null },
        async confirm() { return true },
    }
}

export function Dialogs(_: { manager: DialogManager }) {
    return null
}
