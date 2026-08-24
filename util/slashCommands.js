import { getContext, extension_settings } from "../../../../extensions.js";
import { extensionName, runPipeline, saveSettings } from "../index.js";

/* Commands:
/rc-run mesId (If no mes Id runs on last message)
/rc-runbulk From_mesId-To_mesId WaitTime (Bulk runs from X to Y message, optional wait time between requests default 1 second)
/rc-toggle toggleTo (Toggles to true or false accordingly the extension enabled, if none just toggles it)
/rc-diffToggle toggleTo (Toggles to true or false accordingly the diff viewer setting, if none just toggles it)

/rc-customrun mesId=mesId passes={1, 2, 3} (allows you to run a custom pass with specific pass settings.)
/rc-profile profileName (Switches current profile or returns the name of the current profile if nothing is passed)
*/

export function initSlashCommands() {
    const ctx = getContext();
    const SlashCommandParser = ctx.SlashCommandParser;
    const SlashCommand = ctx.SlashCommand;
    const SlashCommandArgument = ctx.SlashCommandArgument;
    const SlashCommandNamedArgument = ctx.SlashCommandNamedArgument;
    const ARGUMENT_TYPE = ctx.ARGUMENT_TYPE;
}
