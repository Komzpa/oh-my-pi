/** Shared task refusal wording for extension gates, including per-item admission. */
export function formatSpawnRefusal(reason: string, id?: string): string {
	return id
		? `REFUSED: no worker was spawned for ${id}: ${reason.replace(/\s*\n\s*/g, " ")}`
		: `REFUSED: no worker was spawned.\n${reason}`;
}
