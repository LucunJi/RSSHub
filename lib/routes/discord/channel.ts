import { DataItem, Route } from '@/types';

import { config } from '@/config';
import { parseDate } from '@/utils/parse-date';
import { art } from '@/utils/render';
import path from 'node:path';
import { baseUrl, getChannel, getChannelMessages, getGuild } from './discord-api';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import { parse } from 'discord-markdown-parser';
import { SingleASTNode } from '@khanacademy/simple-markdown';
import logger from '@/utils/logger';

export const route: Route = {
    path: '/channel/:channelId',
    categories: ['social-media'],
    example: '/discord/channel/950465850056536084',
    parameters: { channelId: 'Channel ID' },
    features: {
        requireConfig: [
            {
                name: 'DISCORD_AUTHORIZATION',
                description: 'Discord authorization header from the browser',
            },
        ],
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['discord.com/channels/:guildId/:channelId/:messageID', 'discord.com/channels/:guildId/:channelId'],
        },
    ],
    name: 'Channel Messages',
    maintainers: ['TonyRL'],
    handler,
};

async function handler(ctx) {
    if (!config.discord || !config.discord.authorization) {
        throw new ConfigNotFoundError('Discord RSS is disabled due to the lack of <a href="https://docs.rsshub.app/deploy/config#route-specific-configurations">relevant config</a>');
    }
    const { authorization } = config.discord;
    const channelId = ctx.req.param('channelId');

    const channelInfo = await getChannel(channelId, authorization);
    const messagesRaw = await getChannelMessages(channelId, authorization, ctx.req.query('limit') ?? 100);
    const { name: channelName, topic: channelTopic, guild_id: guildId } = channelInfo;

    const guildInfo = await getGuild(guildId, authorization);
    const { name: guildName, icon: guidIcon } = guildInfo;

    // TODO: organize this part better
    const memberNameMap = new Map(messagesRaw.flatMap((msg) => msg.mentions.map((mention) => [mention.id, mention.global_name ?? mention.username])));

    // TODO: support other node types
    class ASTFormatter {
        text = (node) => node.content;
        br = () => '<br>';
        inlineCode = (node) => `<code>${node.content}</code>`;
        everyone = () => '@everyone ';
        twemoji = (node) => node.content;
        emoji = (node) => `<img src="https://cdn.discordapp.com/emojis/${node.id}" alt="${node.name}">`;
        subtext = (node) => `<details>${node.content}</details>`;
        channel = (node) => `${baseUrl}/channels/${guildId}/${node.id}`;

        public heading(node) {
            return `<h${node.level}>${this.parse(node.content)}</h${node.level}>`;
        }

        public strong(node) {
            return `<strong>${this.parse(node.content)}</strong>`;
        }

        public em(node) {
            return `<em>${this.parse(node.content)}</em>`;
        }

        public strikethrough(node) {
            return `<s>${this.parse(node.content)}</s>`;
        }

        public underline(node) {
            return `<u>${this.parse(node.content)}</u>`;
        }

        public blockQuote(node) {
            return `<blockquote>${this.parse(node.content)}</blockquote>`;
        }

        public url(node) {
            return `<a href="${node.target}">${this.parse(node.content)}</a>`;
        }

        public autolink(node) {
            return `<a href="${node.target}">${this.parse(node.content)}</a>`;
        }

        public user(node) {
            return `@${memberNameMap.get(node.id) ?? node.id} `;
        }

        // https://discord.com/developers/docs/reference#message-formatting-timestamp-styles
        public timestamp(node) {
            const formatters = {
                // TODO: make relative time work
                R: (time, locale) =>
                    time.toLocaleTimeString(locale, {
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                    }),
                F: (time, locale) =>
                    time.toLocaleTimeString(locale, {
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                    }),
                f: (time, locale) =>
                    time.toLocaleTimeString(locale, {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                    }),
                D: (time, locale) =>
                    time.toLocaleTimeString(locale, {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                    }),
                d: (time, locale) =>
                    time.toLocaleTimeString(locale, {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                    }),
                T: (time, locale) =>
                    time.toLocaleTimeString(locale, {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                    }),
                t: (time, locale) =>
                    time.toLocaleTimeString(locale, {
                        hour: '2-digit',
                        minute: '2-digit',
                    }),
            };
            const locale = (ctx.req.header('Accepte-Language') as string | undefined)
                ?.split(',')
                .filter((seg) => seg.trim().length > 0)
                .map((seg) => {
                    if (!seg.includes(';')) {
                        return [seg.trim(), 1];
                    }
                    const [l, q] = seg.split(';', 2);
                    return [l.trim(), Number.parseFloat(q.trim())];
                })
                .reduce((prev, curr) => (curr[1] > prev[1] ? curr : prev));
            const time = new Date(Number.parseInt(node.timestamp) * 1000);
            return formatters[node.format ?? 'f'](time, locale ?? 'en-us');
        }

        public parse(ast: SingleASTNode[]): string {
            const parts = ast.map((node) => {
                if (node.type === 'parse' || this[node.type] === undefined) {
                    logger.error(`Unable to parse Markdown AST node: ${JSON.stringify(node)}: Unrecognized Type`);
                    return '<p>markdown node paring failure</p>';
                }
                try {
                    return this[node.type].call(this, node);
                } catch (error) {
                    logger.error(`Failed to parse Markdown AST node: ${JSON.stringify(node)}: ${error}`);
                    return '<p>timestamp paring failure</p>';
                }
            });

            return parts.join('');
        }
    }

    const messages = messagesRaw.map((message) => {
        const ast = parse(message.content, 'normal');
        // TODO: add support for list
        const parsed = new ASTFormatter().parse(ast);
        message.content = parsed;
        // TODO: parse markdown in title
        let title = message.content.split('\n')[0].trim();
        if (title.length === 0) {
            title = message.embeds
                ?.filter((em) => em.title !== undefined && em.title.length > 0)
                .map((em) => em.title)
                .join(' / ');
        }
        return {
            title,
            description: art(path.join(__dirname, 'templates/message.art'), { message, guildInfo }),
            author: `${message.author.global_name ?? message.author.username}(${message.author.username})`,
            pubDate: parseDate(message.timestamp),
            updated: message.edited_timestamp ? parseDate(message.edited_timestamp) : undefined,
            category: `#${channelName}`,
            link: `${baseUrl}/channels/${guildId}/${channelId}/${message.id}`,
        };
    });

    return {
        title: `#${channelName} - ${guildName} - Discord`,
        description: channelTopic,
        link: `${baseUrl}/channels/${guildId}/${channelId}`,
        image: `https://cdn.discordapp.com/icons/${guildId}/${guidIcon}.webp`,
        item: messages as unknown as DataItem[],
        allowEmpty: true,
    };
}
