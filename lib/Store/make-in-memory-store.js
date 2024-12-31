"use strict";
const { DEFAULT_CONNECTION_CONFIG } = require('../Defaults');
const { LabelAssociationType } = require('../Types/LabelAssociation');
const { jidDecode } = require('../WABinary');
const { md5 } = require('../Utils');
const makeOrderedDictionary = require('./make-ordered-dictionary');
const { ObjectRepository } = require('./object-repository');
const KeyedDB = require('@adiwajshing/keyed-db').default;

const waChatKey = (pin) => ({
    key: (c) => (pin ? (c.pinned ? '1' : '0') : '') + (c.archived ? '0' : '1') + (c.conversationTimestamp ? c.conversationTimestamp.toString(16).padStart(8, '0') : '') + c.id,
    compare: (k1, k2) => k2.localeCompare(k1),
});

const waMessageID = (m) => m.key.id || '';

const waLabelAssociationKey = {
    key: (la) => (la.type === LabelAssociationType.Chat ? la.chatId + la.labelId : la.chatId + la.messageId + la.labelId),
    compare: (k1, k2) => k2.localeCompare(k1),
};

const makeMessagesDictionary = () => makeOrderedDictionary(waMessageID);

module.exports = (config) => {
    const socket = config.socket;
    const chatKey = config.chatKey || waChatKey(true);
    const labelAssociationKey = config.labelAssociationKey || waLabelAssociationKey;
    const logger = config.logger || DEFAULT_CONNECTION_CONFIG.logger.child({ stream: 'in-mem-store' }) || {
        debug: console.log,
        error: console.error,
        info: console.log,
    };

    const chats = new KeyedDB(chatKey, c => c.id);
    const messages = {};
    const contacts = {};
    const groupMetadata = {};
    const presences = {};
    const state = { connection: 'close' };
    const labels = new ObjectRepository();
    const labelAssociations = new KeyedDB(labelAssociationKey, labelAssociationKey.key);

    const assertMessageList = (jid) => {
        if (!messages[jid]) {
            messages[jid] = makeMessagesDictionary();
        }
        return messages[jid];
    };

    const contactsUpsert = (newContacts) => {
        const oldContacts = new Set(Object.keys(contacts));
        for (const contact of newContacts) {
            oldContacts.delete(contact.id);
            contacts[contact.id] = { ...contacts[contact.id] || {}, ...contact };
        }
        return oldContacts;
    };

    const labelsUpsert = (newLabels) => {
        for (const label of newLabels) {
            labels.upsertById(label.id, label);
        }
    };

    const bind = (ev) => {
        ev.on('connection.update', update => {
            if (!update) {
                logger.error('Received invalid update');
                return;
            }
            Object.assign(state, update);
        });

        ev.on('messaging-history.set', ({ chats: newChats, contacts: newContacts, messages: newMessages, isLatest }) => {
            if (isLatest) {
                chats.clear();
                for (const id in messages) {
                    delete messages[id];
                }
            }
            const chatsAdded = chats.insertIfAbsent(...newChats).length;
            logger.debug({ chatsAdded }, 'synced chats');
            const oldContacts = contactsUpsert(newContacts);
            if (isLatest) {
                for (const jid of oldContacts) {
                    delete contacts[jid];
                }
            }
            logger.debug({ deletedContacts: isLatest ? oldContacts.size : 0, newContacts }, 'synced contacts');
            for (const msg of newMessages) {
                const jid = msg.key.remoteJid;
                const list = assertMessageList(jid);
                list.upsert(msg, 'prepend');
            }
            logger.debug({ messages: newMessages.length }, 'synced messages');
        });

        ev.on('contacts.upsert', contacts => {
            contactsUpsert(contacts);
        });

        ev.on('contacts.update', async (updates) => {
            for (const update of updates) {
                let contact;
                if (contacts[update.id]) {
                    contact = contacts[update.id];
                } else {
                    const contactHashes = await Promise.all(Object.keys(contacts).map(async (contactId) => {
                        const { user } = jidDecode(contactId);
                        return [contactId, (await md5(Buffer.from(user + 'WA_ADD_NOTIF', 'utf8'))).toString('base64').slice(0, 3)];
                    }));
                    contact = contacts[(contactHashes.find(([, b]) => b === update.id))?.[0] || ''];
                }
                if (contact) {
                    if (update.imgUrl === 'changed') {
                        contact.imgUrl = socket ? await socket.profilePictureUrl(contact.id) : undefined;
                    } else if (update.imgUrl === 'removed') {
                        delete contact.imgUrl;
                    }
                } else {
                    logger.debug({ update }, 'got update for non-existent contact');
                    return;
                }
                Object.assign(contacts[contact.id], contact);
            }
        });

        ev.on('chats.upsert', newChats => {
            chats.upsert(...newChats);
        });

        ev.on('chats.update', updates => {
            for (let update of updates) {
                const result = chats.update(update.id, chat => {
                    if (update.unreadCount > 0) {
                        update = { ...update };
                        update.unreadCount = (chat.unreadCount || 0) + update.unreadCount;
                    }
                    Object.assign(chat, update);
                });
                if (!result) {
                    logger.debug({ update }, 'got update for non-existent chat');
                }
            }
        });

        ev.on('labels.edit', (label) => {
            if (label.deleted) {
                return labels.deleteById(label.id);
            }
            if (labels.count() < 20) {
                return labels.upsertById(label.id, label);
            }
            logger.error('Labels count exceeded');
        });

        ev.on('labels.association', ({ type, association }) => {
            switch (type) {
                case 'add':
                    labelAssociations.upsert(association);
                    break;
                case 'remove':
                    labelAssociations.delete(association);
                    break;
                default:
                    console.error(`unknown operation type [${type}]`);
            }
        });

        ev.on('presence.update', ({ id, presences: update }) => {
            presences[id] = presences[id] || {};
            Object.assign(presences[id], update);
        });

        ev.on('chats.delete', deletions => {
            for (const item of deletions) {
                if (chats.get(item)) {
                    chats.deleteById(item);
                }
            }
        });

        ev.on('messages.upsert', ({ messages: newMessages, type }) => {
            switch (type) {
                case 'append':
                case 'notify':
                    for (const msg of newMessages) {
                        const jid = jidDecode(msg.key.remoteJid);
                        const list = assertMessageList(jid);
                        list.upsert(msg, 'append');
                        if (type === 'notify') {
                            if (!chats.get(jid)) {
                                ev.emit('chats.upsert', [{ id: jid, name: msg.key.remoteJid }]);
                            }
                        }
                    }
                    break;
                default:
                    logger.error(`unknown upsert type ${type}`);
            }
        });
    };

    return {
        bind,
        chats,
        contacts,
        messages,
        presences,
        labels,
        labelAssociations,
        groupMetadata,
    };
};
