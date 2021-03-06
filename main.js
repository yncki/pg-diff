#!/usr/bin/env node
const memory = require("./src/memory");
const chalk = require("chalk");
const { Spinner } = require("clui");
const figlet = require("figlet");
const fs = require("fs");
const path = require("path");
const pjson = require("./package.json");
const schema = require("./src/retrieveSchema");
const compareSchema = require("./src/compareSchema");
const data = require("./src/retrieveRecords");
const compareRecords = require("./src/compareRecords");
const { Client } = require("pg");
const pgTypes = require("pg").types;
const log = console.log;

pgTypes.setTypeParser(1114, value => new Date(Date.parse(`${value}+0000`)));


__printIntro();
__readArguments().catch(err => {
    __handleError(err);
    process.exitCode = -1;
    process.exit();
});

function __printHelp() {
    log();
    log();
    log(chalk.magenta("=============================="));
    log(chalk.magenta("===   pg-diff-cli   HELP   ==="));
    log(chalk.magenta("=============================="));
    log();
    log(chalk.gray("OPTION                 \t\tDESCRIPTION"));
    log(chalk.green("-h,  --help           \t\t") + chalk.blue("To show this help."));
    log(chalk.green("-c,  --compare        \t\t") + chalk.blue("To run compare and generate a patch file."));
    log(chalk.green("-m,  --migrate        \t\t") + chalk.blue("To run migration applying all missing patch files."));
    /* log(chalk.green('-mu, --migrate-upto   \t\t') + chalk.blue('To run migration applying all patch files till the specified patch file.')); */
    log(chalk.green("-mr, --migrate-replay \t\t") + chalk.blue("To run migration applying all missing or failed or stuck patch files."));
    log(chalk.green("-s, --save            \t\t") + chalk.blue("To save\\register patch on migration history table without executing the script."));
   // log(chalk.green("-cg, --checkGrants    \t\t") + chalk.blue("Check grants"));
    log();
    log();
    log(chalk.gray(" TO COMPARE: ") + chalk.yellow("pg-diff ") + chalk.gray("-c ") + chalk.cyan("configuration-name script-name"));
    log(chalk.gray("    EXAMPLE: ") + chalk.yellow("pg-diff ") + chalk.gray("-c ") + chalk.cyan("development my-script"));
    log();
    log(chalk.gray(" TO MIGRATE: ") + chalk.yellow("pg-diff ") + chalk.gray("[-m | -mr] ") + chalk.cyan("configuration-name"));
    log(chalk.gray("    EXAMPLE: ") + chalk.yellow("pg-diff ") + chalk.gray("-m ") + chalk.cyan("development"));
    log(chalk.gray("    EXAMPLE: ") + chalk.yellow("pg-diff ") + chalk.gray("-mr ") + chalk.cyan("development"));
    /*     log();
        log(chalk.gray(" TO MIGRATE: ") + chalk.yellow("pg-diff ") + chalk.gray("-mu ") + chalk.cyan("configuration-name patch-file-name"));
        log(chalk.gray("    EXAMPLE: ") + chalk.yellow("pg-diff ") + chalk.gray("-mu ") + chalk.cyan("development 20182808103040999_my-script.sql")); */
    log();
    log(chalk.gray("TO REGISTER: ") + chalk.yellow("pg-diff ") + chalk.gray("-s ") + chalk.cyan("configuration-name patch-file-name"));
    log(chalk.gray("    EXAMPLE: ") + chalk.yellow("pg-diff ") + chalk.gray("-s ") + chalk.cyan("development 20182808103040999_my-script.sql"));
    log();
    log();
}

function __printIntro() {
    log(chalk.yellow(figlet.textSync(pjson.name, { horizontalLayout: "full" })));
    log();
    log(chalk.blue("     Author: ") + chalk.green(pjson.author));
    log(chalk.blue("    Version: ") + chalk.green(pjson.version));
    log(chalk.blue(" PostgreSQL: ") + chalk.green(pjson.pgver));
    log(chalk.blue("    License: ") + chalk.green(pjson.license));
    log(chalk.blue("Description: ") + chalk.green(pjson.description));
    log();
}



function clearEmptyLines(path) {

    let content = fs.readFileSync(path, {encoding: 'utf8'});
    content = content.replace(/(^[ \t]*\n)/gm, "");
    fs.writeFileSync(path,content,{encoding: 'utf8'});

    // fs.readFile(path, 'utf-8', function(err, data){
    //     if (err) throw err;
    //
    //     // var newValue = data.replace(/^\./gim, 'myString');
    //     // data = data.toString();
    //     data = data.replace(/(^[ \t]*\n)/gm, "");
    //     fs.writeFile(path + '.cleaned',  data.toString() , 'utf-8', function (err) {
    //         if (err) throw err;
    //         // console.log('filelistAsync complete');
    //     });
    // });
}


function __printOptions() {
    log();
    log(chalk.gray("CONFIGURED OPTIONS"));
    log(chalk.yellow("         Script Author: ") + chalk.green(memory.config.options.author));
    log(chalk.yellow("      Output Directory: ") + chalk.green(path.resolve(process.cwd(), memory.config.options.outputDirectory)));
    log(chalk.yellow("     Schema Namespaces: ") + chalk.green(memory.config.options.schemaCompare.namespaces));
    log(chalk.yellow("     Idempotent Script: ") + chalk.green(memory.config.options.schemaCompare.idempotentScript ? "ENABLED" : "DISABLED"));
    log(chalk.yellow("          Data Compare: ") + chalk.green(memory.config.options.dataCompare.enable ? "ENABLED" : "DISABLED"));
    log(chalk.yellow("        Compare grants: ") + chalk.green(memory.config.options.schemaCompare.grants ? "ENABLED" : "DISABLED"));
    log(chalk.yellow("       Compare indexes: ") + chalk.green(memory.config.options.schemaCompare.indexes ? "ENABLED" : "DISABLED"));
    log();
}

async function __readArguments() {
    var args = process.argv.slice(2);
    if (args.length <= 0) {
        log(chalk.red("Missing arguments!"));
        __printHelp();
        process.exit();
    }

    switch (args[0]) {
        case "-h":
        case "--help": {
            __printHelp();
            process.exit();
            break;
        }
        //case "-cg":
        // case "-checkGrants":
        //     memory.checkGrants = true;
        //     break;

        case "-c":
        case "--compare":
            {
                if (args.length !== 3) {
                    log(chalk.red("Missing arguments!"));
                    __printHelp();
                    process.exit();
                }
                memory.configName = args[1];
                memory.scriptName = args[2];
                __loadConfig();
                __validateCompareConfig();
                __printOptions();
                await __initDbConnections();
                await __runComparison();
            }
            break;
        case "-m":
        case "--migrate":
        case "-mr":
        case "--migrate-replay":
            {
                if (args.length !== 2) {
                    log(chalk.red("Missing arguments!"));
                    __printHelp();
                    process.exit();
                }

                if (args[0] === "-mr" || args[0] === "--migrate-replay") memory.replayMigration = true;

                memory.configName = args[1];
                __loadConfig();
                __validateMigrationConfig();
                __printOptions();
                await __initDbConnections();
                await __runMigration();
            }
            break;
        case "-s":
        case "--save":
            {
                if (args.length !== 3) {
                    log(chalk.red("Missing arguments!"));
                    __printHelp();
                    process.exit();
                }
                memory.configName = args[1];
                memory.scriptName = args[2];
                __loadConfig();
                __printOptions();
                await __initDbConnections();
                await __runSavePatch();
            }
            break;
        default: {
            log(chalk.red("Missing arguments!"));
            __printHelp();
            process.exit();
        }
    }
}

function __loadConfig() {
    try {
        let configFile = require(path.resolve(process.cwd(), "pg-diff-config.json"));
        if (!configFile[memory.configName]) throw new Error(`Impossible to find the configuration with name ${memory.configName} !`);
        console.log(`Using ${memory.configName}`);

        memory.config = configFile[memory.configName];

        if (!memory.config.options) throw new Error('The configuration section "options" must exists !');

        if (!memory.config.source) throw new Error('The configuration doesn\'t contains the section "source (object)" !');

        if (!memory.config.target) throw new Error('The configuration doesn\'t contains the section "target (object)" !');

        let outputDirectory = path.resolve(process.cwd(), memory.config.options.outputDirectory);

        if (!fs.existsSync(outputDirectory)){
            fs.mkdirSync(outputDirectory,{ recursive: true });
            log('Creating output directory ' + outputDirectory);
        }


        // log(path.resolve(process.cwd(), memory.config.options.outputDirectory));

    } catch (e) {
        __handleError(e);
        process.exitCode = -1;
        process.exit();
    }
}

function __validateCompareConfig() {
    try {
        if (!memory.config.options.outputDirectory)
            throw new Error('The configuration section "options" must contains property "outputDirectory (string)" !');

        if (!memory.config.options.schemaCompare)
            throw new Error('The configuration section "options" must contains property "schemaCompare (object)" !');

        if (!memory.config.options.schemaCompare.hasOwnProperty("namespaces"))
            throw new Error('The configuration section "options.schemaCompare" must contains property "namespaces (array of strings)" !');

        if (!memory.config.options.schemaCompare.hasOwnProperty("indexes"))
            throw new Error('The configuration section "options.schemaCompare" must contains property "indexes (boolean)" !');


        if (!memory.config.options.schemaCompare.hasOwnProperty("idempotentScript"))
            throw new Error('The configuration section "options.schemaCompare" must contains property "idempotentScript (boolean)" !');

        if (!memory.config.options.dataCompare)
            throw new Error('The configuration section "options" must contains property "dataCompare (object)" !');

        if (!memory.config.options.dataCompare.hasOwnProperty("enable"))
            throw new Error('The configuration section "options.dataCompare" must contains property "enable (boolean)" !');
    } catch (e) {
        __handleError(e);
        process.exitCode = -1;
        process.exit();
    }
}

function __validateMigrationConfig() {
    try {
        if (!memory.config.options.migration) throw new Error('The configuration section "options" must contains property "migration (object)" !');

        if (!memory.config.options.migration.hasOwnProperty("tableSchema"))
            throw new Error('The configuration section "options.migration" must contains property "tableSchema (string)" !');

        if (!memory.config.options.migration.hasOwnProperty("tableName"))
            throw new Error('The configuration section "options.migration" must contains property "tableName (string)" !');
    } catch (e) {
        __handleError(e);
        process.exitCode = -1;
        process.exit();
    }
}

async function __initDbConnections() {
    log();
    var spinner = new Spinner(chalk.blue("Connecting to source database ..."), ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"]);
    spinner.start();

    memory.sourceClient = new Client({
        user: memory.config.source.user,
        host: memory.config.source.host,
        database: memory.config.source.database,
        password: memory.config.source.password,
        port: memory.config.source.port,
    });

    await memory.sourceClient.connect();
    spinner.stop();
    memory.sourceDatabaseVersion = __parseSemVersion(
        (await memory.sourceClient.query("SELECT current_setting('server_version')")).rows[0].current_setting,
    );
    log(
        chalk.blue(
            `Connected to PostgreSQL ${memory.sourceDatabaseVersion.value} on [${memory.config.source.host}:${memory.config.source.port}/${memory.config.source.database}] `,
        ) + chalk.green("✓"),
    );
    memory.sourceClient.version = memory.sourceDatabaseVersion;

    var spinner = new Spinner(chalk.blue("Connecting to target database ..."), ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"]);
    spinner.start();

    memory.targetClient = new Client({
        user: memory.config.target.user,
        host: memory.config.target.host,
        database: memory.config.target.database,
        password: memory.config.target.password,
        port: memory.config.target.port,
    });

    await memory.targetClient.connect();
    spinner.stop();
    memory.targetDatabaseVersion = __parseSemVersion(
        (await memory.targetClient.query("SELECT current_setting('server_version')")).rows[0].current_setting,
    );
    log(
        chalk.blue(
            `Connected to PostgreSQL ${memory.targetDatabaseVersion.value} on [${memory.config.target.host}:${memory.config.target.port}/${memory.config.target.database}] `,
        ) + chalk.green("✓"),
    );
    memory.targetClient.version = memory.targetDatabaseVersion;
}

async function __runComparison() {


    log();
    log(chalk.yellow("Collect SOURCE database objects"));
    let sourceSchema = await schema.collectSchemaObjects(
        memory.sourceClient,
        memory.config.options.schemaCompare.namespaces,
        memory.sourceDatabaseVersion,
    );


    log();
    log();
    log(chalk.yellow("Collect TARGET database objects"));
    let targetSchema = await schema.collectSchemaObjects(
        memory.targetClient,
        memory.config.options.schemaCompare.namespaces,
        memory.targetDatabaseVersion,
    );

    log();
    log();
    log(chalk.yellow("Compare SOURCE with TARGET database objects"));

    let scripts = compareSchema.compareDatabaseObjects(sourceSchema, targetSchema);

    //console.dir(scripts, { depth: null });

    if (memory.config.options.dataCompare.enable) {
        memory.sourceDataTypes = (await sourceClient.query(`SELECT oid, typcategory, typname FROM pg_type`)).rows;

        log();
        log();
        log(chalk.yellow("Collect SOURCE tables records"));
        let sourceTablesRecords = await data.collectTablesRecords(sourceClient, memory.config.options.dataCompare.tables);

        log();
        log();
        log(chalk.yellow("Collect TARGET tables records"));
        let targetTablesRecords = await data.collectTablesRecords(targetClient, memory.config.options.dataCompare.tables);

        log();
        log();
        log(chalk.yellow("Compare SOURCE with TARGET database table records"));
        scripts = scripts.concat(
            compareRecords.compareTablesRecords(memory.config.options.dataCompare.tables, sourceTablesRecords, targetTablesRecords),
        );
    } else {
        log();
        log();
        log(chalk.yellow("Data compare not enabled!"));
    }

    let scriptFilePath = await __saveSqlScript(scripts,sourceSchema,targetSchema);

    log(chalk.yellow("Clearing output script..."));
    clearEmptyLines(scriptFilePath);
    log(chalk.yellow("Clearing output script...done"));

    log();
    log();
    log(chalk.whiteBright("SQL patch file has been created succesfully at: ") + chalk.green(scriptFilePath));

    process.exit();
}

function __handleError(e) {
    log();
    log(chalk.red(e));
    log(chalk.magenta(e.stack));

    if (e.code === "MODULE_NOT_FOUND") {
        log(chalk.red('Please create the configuration file "pg-diff-config.json" in the same folder where you run pg-diff!'));
    } else {
        log(chalk.red('HandleError: ' + e.code));
    }
}

async function __saveSqlScript(scriptLines,sourceSchema,targetSchema) {
    return new Promise((resolve, reject) => {
        const now = new Date();
        const fileName = `${now.toISOString().replace(/[-:\.TZ]/g, "")}_${memory.scriptName}.sql`;
        const scriptPath = path.resolve(process.cwd(), memory.config.options.outputDirectory, fileName);

        var file = fs.createWriteStream(scriptPath);

        file.on("error", reject);

        file.on("finish", () => resolve(scriptPath));

        let titleLength =
            memory.config.options.author.length > now.toISOString().length ? memory.config.options.author.length : now.toISOString().length;

        file.write(`/******************${"*".repeat(titleLength + 2)}***/\n`);
        file.write(`/*** SCRIPT AUTHOR: ${memory.config.options.author.padEnd(titleLength)} ***/\n`);
        file.write(`/***    CREATED ON: ${now.toISOString().padEnd(titleLength)} ***/\n`);
        file.write(`/***    SOURCE: ${memory.sourceClient.database} @ ${memory.sourceClient.host} ***/\n`);
        file.write(`/***    TARGET: ${memory.targetClient.database} @ ${memory.targetClient.host} ***/\n`);
       // console.log(sourceSchema);
        file.write(`/******************${"*".repeat(titleLength + 2)}***/\n`);

        scriptLines.forEach(function(line) {
            file.write(line);
        });

        file.end();
    });
}

async function __runMigration() {
    memory.sourceDataTypes = (await sourceClient.query(`SELECT oid, typcategory, typname FROM pg_type`)).rows;
    const migratePatch = require("./src/migratePatch");
    await migratePatch.migrate();

    process.exit();
}

async function __runSavePatch() {
    memory.sourceDataTypes = (await sourceClient.query(`SELECT oid, typcategory, typname FROM pg_type`)).rows;
    const migratePatch = require("./src/migratePatch");
    await migratePatch.savePatch();
    process.exit();
}

function __parseSemVersion(version) {
    if (typeof version != "string") {
        return false;
    }
    let versionArray = version.split(".");

    return {
        major: parseInt(versionArray[0]) || 0,
        minor: parseInt(versionArray[1]) || 0,
        patch: parseInt(versionArray[2]) || 0,
        value: version,
    };
}
