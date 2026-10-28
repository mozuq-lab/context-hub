export interface OpenClawProposalOptions { repo:string; home:string; configPath:string; guildId:string; channelId:string; allowedSenderIds:string[] }
export function proposeOpenClaw(original: any, options: OpenClawProposalOptions): {config:any;changes:Array<{op:string;path:string;value:unknown}>;diff:string};
