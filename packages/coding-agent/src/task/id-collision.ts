const OMP_COLLISION_SUFFIX_CHAIN = /(?:-\d+)+$/;

export function stripOmpCollisionSuffixChain(id: string): string {
	const base = id.replace(OMP_COLLISION_SUFFIX_CHAIN, "");
	return base.length > 0 ? base : id;
}
