// SillyTavern 1.18 can copy integrity into branch chats. Store a separate
// extension-owned scope in native metadata without changing that integrity.
export const SCOPE = 'red_pen_scope_v1';

export function chatIdentity(context, user) {
    if (!context.chatId || !context.chatMetadata?.integrity) return null;
    const owner = JSON.stringify([user, context.groupId ? 'group' : 'character', context.groupId || context.characters[context.characterId]?.avatar]);
    if (!context.groupId && !context.characters[context.characterId]?.avatar) return null;
    const scope = context.chatMetadata[SCOPE];
    if (scope !== undefined && (typeof scope !== 'string' || !scope || scope.length > 128)) throw new Error('红笔聊天隔离标识无效，请先恢复聊天备份');
    const parts = [owner, context.chatMetadata.integrity];
    if (scope) parts.push(scope);
    return { owner, key: JSON.stringify(parts), label: context.chatId };
}

export function needsSeparateScope(context, identity, library) {
    const parent = context.chatMetadata?.main_chat || null;
    if (!library) return !!parent && !context.chatMetadata[SCOPE];
    // New libraries remember the native branch lineage. Renaming does not
    // change that lineage, while branching from this chat does.
    if (Object.prototype.hasOwnProperty.call(library, 'branchParent')) return library.branchParent !== parent;
    // Preserve existing 0.1.0 libraries, including renamed 1.19 branches.
    if (library.label === identity.label || (library.inheritedFrom && parent)) return false;
    return !!parent;
}
