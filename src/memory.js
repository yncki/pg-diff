let memory = {
    configName: "",
    scriptName:"",
    config: null,
    replayMigration: false,
    schemaChanges: {
        newColumns: {},
    },
    sourceClient: null,
    sourceDatabaseVersion: null,
    sourceDataTypes:null,
    targetClient: null,
    targetDatabaseVersion: null
};
module.exports = memory;