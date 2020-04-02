const sql = require('./sqlScriptGenerator');
const {
    Progress
} = require('clui');
const chalk = require('chalk');

const helper = {
    __finalScripts: [],
    __tempScripts: [],
    __droppedConstraints: [],
    __droppedIndexes: [],
    __droppedViews: [],
    __progressBar: new Progress(20),
    __progressBarValue: 0.0,
    __sourceSchema: {},
    __targetSchema: {},
    __updateProgressbar: function (value, label) {
        this.__progressBarValue = value;
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        process.stdout.write(this.__progressBar.update(this.__progressBarValue) + ' - ' + chalk.whiteBright(label));
    },
    __appendScripts: function (actionLabel) {
        if (this.__tempScripts.length > 0) {
            this.__finalScripts.push(`\n--- BEGIN ${actionLabel} ---\n`);
            this.__finalScripts = this.__finalScripts.concat(this.__tempScripts);
            this.__finalScripts.push(`\n--- END ${actionLabel} ---\n`);
        }
    },
    __compareSchemas: function () {
        this.__updateProgressbar(this.__progressBarValue + 0.0001, 'Comparing schemas');
        const progressBarStep = 0.1665 / Object.keys(this.__sourceSchema.schemas).length;

        for (let schemaName in this.__sourceSchema.schemas) { //Get missing schemas on target
            if (this.__sourceSchema.schemas.hasOwnProperty(schemaName)) {
                this.__updateProgressbar(this.__progressBarValue + progressBarStep, `Comparing SCHEMA ${schemaName}`);
                this.__tempScripts = [];

                if (!this.__targetSchema.schemas[schemaName]) { //Schema not exists on target database, then generate script to create schema
                    this.__tempScripts.push(sql.generateCreateSchemaScript(schemaName, this.__sourceSchema.schemas[schemaName].owner));
                }

                this.__appendScripts(`CREATE SCHEMA ${schemaName}`);
            }
        }
    },
    __compareTables: function () {
        this.__updateProgressbar(this.__progressBarValue + 0.0001, 'Comparing tables');
        let tablesToCompareLength = Object.keys(this.__sourceSchema.tables).length;

        if (global.config.options.schemaCompare.dropMissingTable) {
            tablesToCompareLength += Object.keys(this.__targetSchema.tables).length;
        }

        const progressBarStep = 0.1665 / tablesToCompareLength;

        for (let table in this.__sourceSchema.tables) { //Get new or changed tables
            if (this.__sourceSchema.tables.hasOwnProperty(table)) {
                this.__updateProgressbar(this.__progressBarValue + progressBarStep, `Comparing SOURCE TABLE ${table}`);
                this.__tempScripts = [];
                this.__droppedConstraints = [];
                this.__droppedIndexes = [];
                let actionLabel = '';

                if (this.__targetSchema.tables[table]) { //Table exists on both database, then compare table schema
                    actionLabel = 'ALTER';

                    this.__compareTableOptions(table, this.__sourceSchema.tables[table].options, this.__targetSchema.tables[table].options);
                    this.__compareTableColumns(table, this.__sourceSchema.tables[table].columns, this.__targetSchema.tables[table].columns, this.__targetSchema.tables[table].constraints, this.__targetSchema.tables[table].indexes);
                    this.__compareTableConstraints(table, this.__sourceSchema.tables[table].constraints, this.__targetSchema.tables[table].constraints);
                    this.__compareTableIndexes(this.__sourceSchema.tables[table].indexes, this.__targetSchema.tables[table].indexes);
                    this.__compareTablePrivileges(table, this.__sourceSchema.tables[table].privileges, this.__targetSchema.tables[table].privileges);
                    if (this.__sourceSchema.tables[table].owner !== this.__targetSchema.tables[table].owner)
                        this.__tempScripts.push(sql.generateChangeTableOwnerScript(table, this.__sourceSchema.tables[table].owner));
                } else { //Table not exists on target database, then generate the script to create table
                    actionLabel = 'CREATE';

                    this.__tempScripts.push(sql.generateCreateTableScript(table, this.__sourceSchema.tables[table]));
                }

                this.__appendScripts(`${actionLabel} TABLE ${table}`);
            }
        }

        if (global.config.options.schemaCompare.dropMissingTable)
            for (let table in this.__targetSchema.tables) { //Get missing tables
                if (this.__targetSchema.tables.hasOwnProperty(table)) {
                    this.__updateProgressbar(this.__progressBarValue + progressBarStep, `Comparing TARGET TABLE ${table}`);
                    this.__tempScripts = [];

                    if (!this.__sourceSchema.tables.hasOwnProperty(table))
                        this.__tempScripts.push(sql.generateDropTableScript(table));

                    this.__appendScripts(`DROP TABLE ${table}`);
                }
            }
    },
    __compareTableOptions: function (table, sourceTableOptions, targetTableOptions) {
        if (sourceTableOptions.withOids !== targetTableOptions.withOids)
            this.__tempScripts.push(sql.generateChangeTableOptionsScript(table, sourceTableOptions));
    },
    __compareTableColumns: function (table, sourceTableColumns, targetTableColumns, targetTableConstraints, targetTableIndexes) {
        for (let column in sourceTableColumns) { //Get new or changed columns
            if (sourceTableColumns.hasOwnProperty(column)) {
                if (targetTableColumns[column]) { //Table column exists on both database, then compare column schema
                    this.__compareTableColumn(table, column, sourceTableColumns[column], targetTableColumns[column], targetTableConstraints, targetTableIndexes);
                } else { //Table column not exists on target database, then generate script to add column
                    this.__tempScripts.push(sql.generateAddTableColumnScript(table, column, sourceTableColumns[column]));
                    if (!global.schemaChanges.newColumns[table])
                        global.schemaChanges.newColumns[table] = [];

                    global.schemaChanges.newColumns[table].push(column);
                }
            }
        }
        for (let column in targetTableColumns) { //Get dropped columns
            if (targetTableColumns.hasOwnProperty(column)) {
                if (!sourceTableColumns[column]) //Table column not exists on source, then generate script to drop column
                    this.__tempScripts.push(sql.generateDropTableColumnScript(table, column))
            }
        }
    },
    __compareTableColumn: function (table, column, sourceTableColumn, targetTableColumn, targetTableConstraints, targetTableIndexes) {
        let changes = {};

        if (sourceTableColumn.nullable !== targetTableColumn.nullable)
            changes.nullable = sourceTableColumn.nullable;

        if (sourceTableColumn.datatype !== targetTableColumn.datatype ||
            sourceTableColumn.precision !== targetTableColumn.precision ||
            sourceTableColumn.scale !== targetTableColumn.scale) {
            changes.datatype = sourceTableColumn.datatype;
            changes.dataTypeID = sourceTableColumn.dataTypeID;
            changes.dataTypeCategory = sourceTableColumn.dataTypeCategory;
            changes.precision = sourceTableColumn.precision;
            changes.scale = sourceTableColumn.scale;
        }

        if (sourceTableColumn.default !== targetTableColumn.default)
            changes.default = sourceTableColumn.default;

        if (sourceTableColumn.identity !== targetTableColumn.identity) {
            changes.identity = sourceTableColumn.identity;

            changes.isNewIdentity = targetTableColumn.identity == null;
        }

        if (Object.keys(changes).length > 0) {
            let rawColumnName = column.substring(1).slice(0, -1);

            //Check if the column is under constrains
            for (let constraint in targetTableConstraints) {
                if (targetTableConstraints.hasOwnProperty(constraint)) {
                    if (this.__droppedConstraints.includes(constraint))
                        continue;

                    let constraintDefinition = targetTableConstraints[constraint].definition;
                    let searchStartingIndex = constraintDefinition.indexOf('(');

                    if (constraintDefinition.includes(`${rawColumnName},`, searchStartingIndex) ||
                        constraintDefinition.includes(`${rawColumnName})`, searchStartingIndex) ||
                        constraintDefinition.includes(`${column}`, searchStartingIndex)) {
                        this.__tempScripts.push(sql.generateDropTableConstraintScript(table, constraint));
                        this.__droppedConstraints.push(constraint);
                    }
                }
            }

            //Check if the column is part of indexes
            for (let index in targetTableIndexes) {
                if (targetTableIndexes.hasOwnProperty(index)) {
                    let indexDefinition = targetTableIndexes[index].definition;
                    let searchStartingIndex = indexDefinition.indexOf('(');

                    if (indexDefinition.includes(`${rawColumnName},`, searchStartingIndex) ||
                        indexDefinition.includes(`${rawColumnName})`, searchStartingIndex) ||
                        indexDefinition.includes(`${column}`, searchStartingIndex)) {
                        this.__tempScripts.push(sql.generateDropIndexScript(index));
                        this.__droppedIndexes.push(index);
                    }
                }
            }

            //Check if the column is used into view
            for (let view in this.__targetSchema.views) {
                if (this.__targetSchema.views.hasOwnProperty(view)) {
                    this.__targetSchema.views[view].dependencies.forEach(dependency => {
                        let fullDependencyName = `"${dependency.schemaName}"."${dependency.tableName}"`;
                        if (fullDependencyName === table && dependency.columnName === column) {
                            this.__tempScripts.push(sql.generateDropViewScript(index)); //TODO undefined index
                            this.__droppedViews.push(view);
                        }
                    });
                }
            }

            //Check if the column is used into materialized view
            for (let view in this.__targetSchema.materializedViews) {
                if (this.__targetSchema.materializedViews.hasOwnProperty(view)) {
                    this.__targetSchema.materializedViews[view].dependencies.forEach(dependency => {
                        let fullDependencyName = `"${dependency.schemaName}"."${dependency.tableName}"`;
                        if (fullDependencyName === table && dependency.columnName === column) {
                            this.__tempScripts.push(sql.generateDropMaterializedViewScript(index)); //TODO undefined index
                            this.__droppedViews.push(view);
                        }
                    });
                }
            }

            this.__tempScripts.push(sql.generateChangeTableColumnScript(table, column, changes));
        }
    },
    __compareTableConstraints: function (table, sourceTableConstraints, targetTableConstraints) {
        for (let constraint in sourceTableConstraints) { //Get new or changed constraint
            if (sourceTableConstraints.hasOwnProperty(constraint)) {
                if (targetTableConstraints[constraint]) { //Table constraint exists on both database, then compare column schema
                    if (sourceTableConstraints[constraint].definition !== targetTableConstraints[constraint].definition) {
                        if (!this.__droppedConstraints.includes(constraint))
                            this.__tempScripts.push(sql.generateDropTableConstraintScript(table, constraint));
                        this.__tempScripts.push(sql.generateAddTableConstraintScript(table, constraint, sourceTableConstraints[constraint]));
                    } else {
                        if (this.__droppedConstraints.includes(constraint)) //It will recreate a dropped constraints because changes happens on involved columns
                            this.__tempScripts.push(sql.generateAddTableConstraintScript(table, constraint, sourceTableConstraints[constraint]));
                    }
                } else { //Table constraint not exists on target database, then generate script to add constraint
                    this.__tempScripts.push(sql.generateAddTableConstraintScript(table, constraint, sourceTableConstraints[constraint]));
                }
            }
        }
        for (let constraint in targetTableConstraints) { //Get dropped constraints
            if (targetTableConstraints.hasOwnProperty(constraint)) {
                if (!sourceTableConstraints[constraint] && !this.__droppedConstraints.includes(constraint)) //Table constraint not exists on source, then generate script to drop constraint
                    this.__tempScripts.push(sql.generateDropTableConstraintScript(table, constraint));
            }
        }
    },
    __compareTableIndexes: function (sourceTableIndexes, targetTableIndexes) {
        for (let index in sourceTableIndexes) { //Get new or changed indexes
            if (sourceTableIndexes.hasOwnProperty(index)) {
                if (targetTableIndexes[index]) { //Table index exists on both database, then compare index definition
                    if (sourceTableIndexes[index].definition !== targetTableIndexes[index].definition) {
                        if (!this.__droppedIndexes.includes(index))
                            this.__tempScripts.push(sql.generateDropIndexScript(index));
                        this.__tempScripts.push(`\n${sourceTableIndexes[index].definition};\n`);
                    } else {
                        if (this.__droppedIndexes.includes(index)) //It will recreate a dropped index because changes happens on involved columns
                            this.__tempScripts.push(`\n${sourceTableIndexes[index].definition};\n`);
                    }
                } else { //Table index not exists on target database, then generate script to add index
                    this.__tempScripts.push(`\n${sourceTableIndexes[index].definition};\n`);
                }
            }
        }
        for (let index in targetTableIndexes) { //Get dropped indexes
            if (targetTableIndexes.hasOwnProperty(index)) {
                if (!sourceTableIndexes[index] && !this.__droppedIndexes.includes(index)) //Table index not exists on source, then generate script to drop index
                    this.__tempScripts.push(sql.generateDropIndexScript(index))
            }
        }
    },
    __compareTablePrivileges: function (table, sourceTablePrivileges, targetTablePrivileges) {
        for (let role in sourceTablePrivileges) { //Get new or changed role privileges
            if (sourceTablePrivileges.hasOwnProperty(role)) {
                if (targetTablePrivileges[role]) { //Table privileges for role exists on both database, then compare privileges
                    let changes = {};

                    if (sourceTablePrivileges[role].select !== targetTablePrivileges[role].select)
                        changes.select = sourceTablePrivileges[role].select;

                    if (sourceTablePrivileges[role].insert !== targetTablePrivileges[role].insert)
                        changes.insert = sourceTablePrivileges[role].insert;

                    if (sourceTablePrivileges[role].update !== targetTablePrivileges[role].update)
                        changes.update = sourceTablePrivileges[role].update;

                    if (sourceTablePrivileges[role].delete !== targetTablePrivileges[role].delete)
                        changes.delete = sourceTablePrivileges[role].delete;

                    if (sourceTablePrivileges[role].truncate !== targetTablePrivileges[role].truncate)
                        changes.truncate = sourceTablePrivileges[role].truncate;

                    if (sourceTablePrivileges[role].references !== targetTablePrivileges[role].references)
                        changes.references = sourceTablePrivileges[role].references;

                    if (sourceTablePrivileges[role].trigger !== targetTablePrivileges[role].trigger)
                        changes.trigger = sourceTablePrivileges[role].trigger;

                    if (Object.keys(changes).length > 0)
                        this.__tempScripts.push(sql.generateChangesTableRoleGrantsScript(table, role, changes))
                } else { //Table grants for role not exists on target database, then generate script to add role privileges
                    this.__tempScripts.push(sql.generateTableRoleGrantsScript(table, role, sourceTablePrivileges[role]))
                }
            }
        }
    },
    __compareViews: function () {
        this.__updateProgressbar(this.__progressBarValue + 0.0001, 'Comparing views');
        let viewsToCompareLength = Object.keys(this.__sourceSchema.views).length;

        if (global.config.options.schemaCompare.dropMissingView)
            viewsToCompareLength += Object.keys(this.__targetSchema.views).length;

        const progressBarStep = 0.1665 / viewsToCompareLength;

        for (let view in this.__sourceSchema.views) { //Get new or changed views
            if (this.__sourceSchema.views.hasOwnProperty(view)) {
                this.__updateProgressbar(this.__progressBarValue + progressBarStep, `Comparing SOURCE VIEW ${view}`);
                this.__tempScripts = [];
                let actionLabel = '';

                if (this.__targetSchema.views[view]) { //View exists on both database, then compare view schema
                    actionLabel = 'ALTER';

                    if (this.__sourceSchema.views[view].definition !== this.__targetSchema.views[view].definition) {
                        if (!this.__droppedViews.includes(view))
                            this.__tempScripts.push(sql.generateDropViewScript(view));
                        this.__tempScripts.push(sql.generateCreateViewScript(view, this.__sourceSchema.views[view]));
                    } else {
                        if (this.__droppedViews.includes(view)) //It will recreate a dropped view because changes happens on involved columns
                            this.__tempScripts.push(sql.generateCreateViewScript(view, this.__sourceSchema.views[view]));

                        this.__compareTablePrivileges(view, this.__sourceSchema.views[view].privileges, this.__targetSchema.views[view].privileges);
                        if (this.__sourceSchema.views[view].owner !== this.__targetSchema.views[view].owner)
                            this.__tempScripts.push(sql.generateChangeTableOwnerScript(view, this.__sourceSchema.views[view].owner));
                    }
                } else { //View not exists on target database, then generate the script to create view
                    actionLabel = 'CREATE';

                    this.__tempScripts.push(sql.generateCreateViewScript(view, this.__sourceSchema.views[view]));
                }

                this.__appendScripts(`${actionLabel} VIEW ${view}`);
            }
        }

        if (global.config.options.schemaCompare.dropMissingView)
            for (let view in this.__targetSchema.views) { //Get missing views
                if (this.__targetSchema.views.hasOwnProperty(view)) {
                    this.__updateProgressbar(this.__progressBarValue + progressBarStep, `Comparing TARGET VIEW ${view}`);
                    this.__tempScripts = [];

                    if (!this.__sourceSchema.views.hasOwnProperty(view))
                        this.__tempScripts.push(sql.generateDropViewScript(view));

                    this.__appendScripts(`DROP VIEW ${view}`);
                }
            }
    },
    __compareMaterializedViews: function () {
        this.__updateProgressbar(this.__progressBarValue + 0.0001, 'Comparing materialized views');
        let mviewsToCompareLength = Object.keys(this.__sourceSchema.materializedViews).length;

        if (global.config.options.schemaCompare.dropMissingView)
            mviewsToCompareLength += Object.keys(this.__targetSchema.materializedViews).length;

        const progressBarStep = 0.1665 / mviewsToCompareLength;

        for (let view in this.__sourceSchema.materializedViews) { //Get new or changed materialized views
            if (this.__sourceSchema.materializedViews.hasOwnProperty(view)) {
                this.__updateProgressbar(this.__progressBarValue + progressBarStep, `Comparing SOURCE MATERIALIZED VIEW ${view}`);
                this.__tempScripts = [];
                let actionLabel = '';

                if (this.__targetSchema.materializedViews[view]) { //Materialized view exists on both database, then compare materialized view schema
                    actionLabel = 'ALTER';

                    if (this.__sourceSchema.materializedViews[view].definition !== this.__targetSchema.materializedViews[view].definition) {
                        if (!this.__droppedViews.includes(view))
                            this.__tempScripts.push(sql.generateDropMaterializedViewScript(view));
                        this.__tempScripts.push(sql.generateCreateMaterializedViewScript(view, this.__sourceSchema.materializedViews[view]));
                    } else {
                        if (this.__droppedViews.includes(view)) //It will recreate a dropped materialized view because changes happens on involved columns
                            this.__tempScripts.push(sql.generateCreateMaterializedViewScript(view, this.__sourceSchema.views[view]));

                        this.__compareTableIndexes(this.__sourceSchema.materializedViews[view].indexes, this.__targetSchema.materializedViews[view].indexes);
                        this.__compareTablePrivileges(view, this.__sourceSchema.materializedViews[view].privileges, this.__targetSchema.materializedViews[view].privileges);
                        if (this.__sourceSchema.materializedViews[view].owner !== this.__targetSchema.materializedViews[view].owner)
                            this.__tempScripts.push(sql.generateChangeTableOwnerScript(view, this.__sourceSchema.materializedViews[view].owner));
                    }
                } else { //Materialized view not exists on target database, then generate the script to create materialized view
                    actionLabel = 'CREATE';

                    this.__tempScripts.push(sql.generateCreateMaterializedViewScript(view, this.__sourceSchema.materializedViews[view]));
                }

                this.__appendScripts(`${actionLabel} MATERIALIZED VIEW ${view}`);
            }
        }

        if (global.config.options.schemaCompare.dropMissingView)
            for (let view in this.__targetSchema.materializedViews) { //Get missing materialized views
                if (this.__targetSchema.materializedViews.hasOwnProperty(view)) {
                    this.__updateProgressbar(this.__progressBarValue + progressBarStep, `Comparing TARGET MATERIALIZED VIEW ${view}`);
                    this.__tempScripts = [];

                    if (!this.__sourceSchema.materializedViews.hasOwnProperty(view))
                        this.__tempScripts.push(sql.generateDropMaterializedViewScript(view));

                    this.__appendScripts(`DROP MATERIALIZED VIEW ${view}`);
                }
            }
    },
    __compareProcedures: function () {
        this.__updateProgressbar(this.__progressBarValue + 0.0001, 'Comparing functions');
        let proceduresToCompareLength = Object.keys(this.__sourceSchema.functions).length;

        if (global.config.options.schemaCompare.dropMissingFunction)
            proceduresToCompareLength += Object.keys(this.__targetSchema.functions).length;

        const progressBarStep = 0.1665 / proceduresToCompareLength;

        for (let procedure in this.__sourceSchema.functions) { //Get new or changed procedures
            this.__updateProgressbar(this.__progressBarValue + progressBarStep, `Comparing SOURCE FUNCTION ${procedure}`);
            this.__tempScripts = [];
            let actionLabel = '';

            if (this.__targetSchema.functions[procedure]) { //Procedure exists on both database, then compare procedure definition
                actionLabel = 'ALTER';

                //TODO: Is correct that if definition is different automatically GRANTS and OWNER will not be updated also?
                if (this.__sourceSchema.functions[procedure].definition !== this.__targetSchema.functions[procedure].definition) {
                    this.__tempScripts.push(sql.generateChangeProcedureScript(procedure, this.__sourceSchema.functions[procedure]));
                } else {
                    this.__compareProcedurePrivileges(procedure, this.__sourceSchema.functions[procedure].argTypes, this.__sourceSchema.functions[procedure].privileges, this.__targetSchema.functions[procedure].privileges);
                    if (this.__sourceSchema.functions[procedure].owner !== this.__targetSchema.functions[procedure].owner)
                        this.__tempScripts.push(sql.generateChangeProcedureOwnerScript(procedure, this.__sourceSchema.functions[procedure].argTypes, this.__sourceSchema.functions[procedure].owner));
                }
            } else { //Procedure not exists on target database, then generate the script to create procedure
                actionLabel = 'CREATE';

                this.__tempScripts.push(sql.generateCreateProcedureScript(procedure, this.__sourceSchema.functions[procedure]));
            }

            this.__appendScripts(`${actionLabel} FUNCTION ${procedure}`);
        }

        if (global.config.options.schemaCompare.dropMissingFunction)
            for (let procedure in this.__targetSchema.functions) { //Get missing functions
                this.__updateProgressbar(this.__progressBarValue + progressBarStep, `Comparing TARGET FUNCTION ${procedure}`);
                this.__tempScripts = [];

                if (!this.__sourceSchema.functions.hasOwnProperty(procedure))
                    this.__tempScripts.push(sql.generateDropProcedureScript(procedure));

                this.__appendScripts(`DROP FUNCTION ${procedure}`);
            }
    },
    __compareProcedurePrivileges: function (procedure, argTypes, sourceProcedurePrivileges, targetProcedurePrivileges) {
        for (let role in sourceProcedurePrivileges) { //Get new or changed role privileges
            if (sourceProcedurePrivileges.hasOwnProperty(role)) {
                if (targetProcedurePrivileges[role]) { //Procedure privileges for role exists on both database, then compare privileges
                    let changes = {};
                    if (sourceProcedurePrivileges[role].execute !== targetProcedurePrivileges[role].execute)
                        changes.execute = sourceProcedurePrivileges[role].execute;

                    if (Object.keys(changes).length > 0)
                        this.__tempScripts.push(sql.generateChangesProcedureRoleGrantsScript(procedure, argTypes, role, changes))
                } else { //Procedure grants for role not exists on target database, then generate script to add role privileges
                    this.__tempScripts.push(sql.generateProcedureRoleGrantsScript(procedure, argTypes, role, sourceProcedurePrivileges[role]))
                }
            }
        }
    },
    __compareSequences: function () {
        this.__updateProgressbar(this.__progressBarValue + 0.0001, 'Comparing sequences');
        const progressBarStep = 0.1665 / Object.keys(this.__sourceSchema.sequences).length;

        for (let sequence in this.__sourceSchema.sequences) { //Get new or changed sequences
            if (this.__sourceSchema.sequences.hasOwnProperty(sequence)) {
                this.__updateProgressbar(this.__progressBarValue + progressBarStep, `Comparing SEQUENCE ${sequence}`);
                this.__tempScripts = [];
                let actionLabel = '';
                let renamedOwnedSequence = this.__findRenamedSequenceOwnedByTargetTableColumn(sequence, this.__sourceSchema.sequences[sequence].ownedBy);

                if (renamedOwnedSequence) {
                    actionLabel = 'ALTER';

                    this.__tempScripts.push(sql.generateRenameSequenceScript(renamedOwnedSequence, `"${this.__sourceSchema.sequences[sequence].name}"`));
                    this.__compareSequenceDefinition(sequence, this.__sourceSchema.sequences[sequence], this.__targetSchema.sequences[renamedOwnedSequence]);
                    this.__compareSequencePrivileges(sequence, this.__sourceSchema.sequences[sequence].privileges, this.__targetSchema.sequences[renamedOwnedSequence].privileges);
                } else if (this.__targetSchema.sequences[sequence]) { //Sequence exists on both database, then compare sequence definition
                    actionLabel = 'ALTER';

                    this.__compareSequenceDefinition(sequence, this.__sourceSchema.sequences[sequence], this.__targetSchema.sequences[sequence]);
                    this.__compareSequencePrivileges(sequence, this.__sourceSchema.sequences[sequence].privileges, this.__targetSchema.sequences[sequence].privileges);
                } else { //Sequence not exists on target database, then generate the script to create sequence
                    actionLabel = 'CREATE';

                    this.__tempScripts.push(sql.generateCreateSequenceScript(sequence, this.__sourceSchema.sequences[sequence]));
                }

                this.__appendScripts(`${actionLabel} SEQUENCE ${sequence}`);
            }
        }
    },
    __findRenamedSequenceOwnedByTargetTableColumn: function (sequenceName, tableColumn) {
        let result = null;
        for (let sequence in this.__targetSchema.sequences) {
            if (this.__targetSchema.sequences.hasOwnProperty(sequence)) {
                if (this.__targetSchema.sequences[sequence].ownedBy === tableColumn && sequence !== sequenceName) {
                    result = sequence;
                    break;
                }
            }
        }

        return result;
    },
    __compareSequenceDefinition: function (sequence, sourceSequenceDefinition, targetSequenceDefinition) {
        for (let property in sourceSequenceDefinition) { //Get new or changed properties
            if (sourceSequenceDefinition.hasOwnProperty(property)) {
                if (property === 'privileges' || property === 'ownedBy' || property === 'name') //skip these properties from compare
                    continue;

                if (sourceSequenceDefinition[property] !== targetSequenceDefinition[property])
                    this.__tempScripts.push(sql.generateChangeSequencePropertyScript(sequence, property, sourceSequenceDefinition[property]))
            }
        }
    },
    __compareSequencePrivileges: function (sequence, sourceSequencePrivileges, targetSequencePrivileges) {
        for (let role in sourceSequencePrivileges) { //Get new or changed role privileges
            if (sourceSequencePrivileges.hasOwnProperty(role)) {
                if (targetSequencePrivileges[role]) { //Sequence privileges for role exists on both database, then compare privileges
                    let changes = {};
                    if (sourceSequencePrivileges[role].select !== targetSequencePrivileges[role].select)
                        changes.select = sourceSequencePrivileges[role].select;

                    if (sourceSequencePrivileges[role].usage !== targetSequencePrivileges[role].usage)
                        changes.usage = sourceSequencePrivileges[role].usage;

                    if (sourceSequencePrivileges[role].update !== targetSequencePrivileges[role].update)
                        changes.update = sourceSequencePrivileges[role].update;

                    if (Object.keys(changes).length > 0)
                        this.__tempScripts.push(sql.generateChangesSequenceRoleGrantsScript(sequence, role, changes))
                } else { //Sequence grants for role not exists on target database, then generate script to add role privileges
                    this.__tempScripts.push(sql.generateSequenceRoleGrantsScript(sequence, role, sourceSequencePrivileges[role]))
                }
            }
        }
    },
    compareDatabaseObjects: function (sourceSchema, targetSchema) {
        this.__updateProgressbar(0.0, 'Comparing database objects ...');

        this.__sourceSchema = sourceSchema;
        this.__targetSchema = targetSchema;

        this.__compareSchemas();
        this.__compareTables();
        this.__compareViews();
        this.__compareMaterializedViews();
        this.__compareProcedures();
        this.__compareSequences();

        this.__updateProgressbar(1.0, 'Database objects compared!');

        return this.__finalScripts;
    }
};

module.exports = helper;