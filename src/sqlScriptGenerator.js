const memory = require("./memory");

const hints = {
    addColumnNotNullableWithoutDefaultValue:
        " --WARN: Add a new column not nullable without a default value can occure in a sql error during execution!",
    changeColumnDataType:
        " --WARN: Change column data type can occure in a casting error, the suggested casting expression is the default one and may not fit your needs!",
    dropColumn: " --WARN: Drop column can occure in data loss!",
    potentialRoleMissing:
        " --WARN: Grant\\Revoke privileges to a role can occure in a sql error during execution if role is missing to the target database!",
    identityColumnDetected: " --WARN: Identity column has been detected, an error can occure because constraints violation!",
    dropTable: " --WARN: Drop table can occure in data loss!",
};

module.exports = {
    __generateColumnDataTypeDefinition: function(columnSchema) {
        let dataType = columnSchema.datatype;
        if (columnSchema.precision) {
            let dataTypeScale = columnSchema.scale ? `,${columnSchema.scale}` : "";
            dataType += `(${columnSchema.precision}${dataTypeScale})`;
        }
        return dataType;
    },
    __generateColumnDefinition: function(column, columnSchema) {
        let defaultValue = "";
        if (columnSchema.default) defaultValue = `DEFAULT ${columnSchema.default}`;
        let identityValue = "";
        if (columnSchema.identity) identityValue = `GENERATED ${columnSchema.identity} AS IDENTITY`;
        let dataType = this.__generateColumnDataTypeDefinition(columnSchema);
        return `${column} ${dataType} ${columnSchema.nullable ? "NULL" : "NOT NULL"} ${defaultValue} ${identityValue}`;
    },
    __generateTableGrantsDefinition: function(table, role, privileges) {
        let definitions = [];
        if (memory.config.options.schemaCompare.grants) {
            if (privileges.select) definitions.push(`GRANT SELECT ON TABLE ${table} TO ${role};${hints.potentialRoleMissing}`);
            if (privileges.insert) definitions.push(`GRANT INSERT ON TABLE ${table} TO ${role};${hints.potentialRoleMissing}`);
            if (privileges.update) definitions.push(`GRANT UPDATE ON TABLE ${table} TO ${role};${hints.potentialRoleMissing}`);
            if (privileges.delete) definitions.push(`GRANT DELETE ON TABLE ${table} TO ${role};${hints.potentialRoleMissing}`);
            if (privileges.truncate) definitions.push(`GRANT TRUNCATE ON TABLE ${table} TO ${role};${hints.potentialRoleMissing}`);
            if (privileges.references) definitions.push(`GRANT REFERENCES ON TABLE ${table} TO ${role};${hints.potentialRoleMissing}`);
            if (privileges.trigger) definitions.push(`GRANT TRIGGER ON TABLE ${table} TO ${role};${hints.potentialRoleMissing}`);
        }
        return definitions;
    },
    __generateProcedureGrantsDefinition: function(procedure, argTypes, role, privileges) {
        let definitions = [];
        if (memory.config.options.schemaCompare.grants) {
            if (privileges.execute) definitions.push(`GRANT EXECUTE ON FUNCTION ${procedure}(${argTypes}) TO ${role};${hints.potentialRoleMissing}`);
        }
        return definitions;
    },
    __generateSequenceGrantsDefinition: function(sequence, role, privileges) {
        let definitions = [];
        if (memory.config.options.schemaCompare.grants) {
            if (privileges.select) definitions.push(`GRANT SELECT ON SEQUENCE ${sequence} TO ${role};${hints.potentialRoleMissing}`);

            if (privileges.usage) definitions.push(`GRANT USAGE ON SEQUENCE ${sequence} TO ${role};${hints.potentialRoleMissing}`);

            if (privileges.update) definitions.push(`GRANT UPDATE ON SEQUENCE ${sequence} TO ${role};${hints.potentialRoleMissing}`);
        }
        return definitions;
    },
    generateCreateSchemaScript: function(schema, owner) {
        return `CREATE ${
            memory.config.options.schemaCompare.idempotentScript ? "SCHEMA IF NOT EXISTS" : "SCHEMA"
        } ${schema} AUTHORIZATION ${owner};`;
    },
    generateDropTableScript: function(table) {
        return `DROP ${memory.config.options.schemaCompare.idempotentScript ? "TABLE IF EXISTS" : "TABLE"} ${table};`;
    },
    generateCreateTableScript: function(table, schema) {
        //Generate columns script
        let columns = [];
        for (let column in schema.columns) {
            if (schema.columns.hasOwnProperty(column)) {
                columns.push(this.__generateColumnDefinition(column, schema.columns[column]));
            }
        }

        //Generate constraints script
        for (let constraint in schema.constraints) {
            columns.push(`CONSTRAINT ${constraint} ${schema.constraints[constraint].definition} `);
        }

        //Generate options script
        let options = `WITH ( OIDS=${schema.options.withOids.toString().toUpperCase()} )`;

        //Generate indexes script
        let indexes = [];
        if (memory.config.options.schemaCompare.indexes) {

            for (let index in schema.indexes) {
                if (schema.indexes.hasOwnProperty(index)) {
                    let definition = schema.indexes[index].definition;
                    if (memory.config.options.schemaCompare.idempotentScript) {
                        definition = definition.replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS");
                        definition = definition.replace("CREATE UNIQUE INDEX", "CREATE UNIQUE INDEX IF NOT EXISTS");
                    }

                    indexes.push(`\n${definition};\n`);
                }
            }
        }

        //Generate privileges script
        let privileges = [];
        if (memory.config.options.schemaCompare.grants) {
            privileges.push(
                `ALTER ${memory.config.options.schemaCompare.idempotentScript ? "TABLE IF EXISTS" : "TABLE"} ${table} OWNER TO ${schema.owner};\n`,
            );

            for (let role in schema.privileges) {
                privileges = privileges.concat(this.__generateTableGrantsDefinition(table, role, schema.privileges[role]));
            }
        }

        return `\nCREATE ${memory.config.options.schemaCompare.idempotentScript ? "TABLE IF NOT EXISTS" : "TABLE"} ${table} (\n\t${columns.join(
            ",\n\t",
        )}\n)\n${options};\n${indexes.join("\n")}\n${privileges.join("\n")}\n`;
    },
    generateAddTableColumnScript: function(table, column, schema) {
        let script = `\nALTER ${memory.config.options.schemaCompare.idempotentScript ? "TABLE IF EXISTS" : "TABLE"} ${table} ADD ${
            memory.config.options.schemaCompare.idempotentScript ? "COLUMN IF NOT EXISTS" : "COLUMN"
        } ${this.__generateColumnDefinition(column, schema)};`;
        if (script.includes("NOT NULL") && !script.includes("DEFAULT")) script += hints.addColumnNotNullableWithoutDefaultValue;

        script += "\n";
        return script;
    },
    generateChangeTableColumnScript: function(table, column, changes) {
        let definitions = [];
        if (changes.hasOwnProperty("nullable")) definitions.push(`ALTER COLUMN ${column} ${changes.nullable ? "DROP NOT NULL" : "SET NOT NULL"}`);

        if (changes.hasOwnProperty("datatype")) {
            definitions.push(`${hints.changeColumnDataType}`);
            let dataTypeDefinition = this.__generateColumnDataTypeDefinition(changes);
            definitions.push(`ALTER COLUMN ${column} SET DATA TYPE ${dataTypeDefinition} USING ${column}::${dataTypeDefinition}`);
        }

        if (changes.hasOwnProperty("default"))
            definitions.push(`ALTER COLUMN ${column} ${changes.default ? "SET" : "DROP"} DEFAULT ${changes.default || ""}`);

        if (changes.hasOwnProperty("identity") && changes.hasOwnProperty("isNewIdentity")) {
            let identityDefinition = "";
            if (changes.identity) {
                //truly values
                identityDefinition = `${changes.isNewIdentity ? "ADD" : "SET"} GENERATED ${changes.identity} ${
                    changes.isNewIdentity ? "AS IDENTITY" : ""
                }`;
            } else {
                //falsy values
                identityDefinition = `DROP IDENTITY ${memory.config.options.schemaCompare.idempotentScript ? "IF EXISTS" : ""}`;
            }
            definitions.push(`ALTER COLUMN ${column} ${identityDefinition}`);
        }

        //TODO: Should we include COLLATE when change column data type?

        return `\nALTER ${memory.config.options.schemaCompare.idempotentScript ? "TABLE IF EXISTS" : "TABLE"} ${table}\n\t${definitions.join(
            ",\n\t",
        )};\n`;
    },
    generateDropTableColumnScript: function(table, column) {
        return `\nALTER ${memory.config.options.schemaCompare.idempotentScript ? "TABLE IF EXISTS" : "TABLE"} ${table} DROP ${
            memory.config.options.schemaCompare.idempotentScript ? "COLUMN IF EXISTS" : "COLUMN"
        } ${column} CASCADE;${hints.dropColumn}\n`;
    },
    generateAddTableConstraintScript: function(table, constraint, schema) {
        return `\nALTER ${
            memory.config.options.schemaCompare.idempotentScript ? "TABLE IF EXISTS" : "TABLE"
        } ${table} ADD CONSTRAINT ${constraint} ${schema.definition};\n`;
    },
    generateDropTableConstraintScript: function(table, constraint) {
        return `\nALTER ${memory.config.options.schemaCompare.idempotentScript ? "TABLE IF EXISTS" : "TABLE"} ${table} DROP ${
            memory.config.options.schemaCompare.idempotentScript ? "CONSTRAINT IF EXISTS" : "CONSTRAINT"
        } ${constraint};\n`;
    },
    generateChangeTableOptionsScript: function(table, options) {
        return `\nALTER ${memory.config.options.schemaCompare.idempotentScript ? "TABLE IF EXISTS" : "TABLE"} ${table} SET ${
            options.withOids ? "WITH" : "WITHOUT"
        } OIDS;\n`;
    },
    generateChangeIndexScript: function(index, definition) {
        if (memory.config.options.schemaCompare.indexes) {

            return `\nDROP ${memory.config.options.schemaCompare.idempotentScript ? "INDEX IF EXISTS" : "INDEX"} ${index};\n${definition};\n`;
        } else {
            return '\n';
        }
    },
    generateDropIndexScript: function(table,index) {
        if (memory.config.options.schemaCompare.indexes) {

            return `\nDROP ${memory.config.options.schemaCompare.idempotentScript ? "INDEX IF EXISTS" : "INDEX"} ${index}; ---@ ${table} --- \n`;
        } else {
            return '\n';
        }
    },
    generateTableRoleGrantsScript: function(table, role, privileges) {
        return `\n${this.__generateTableGrantsDefinition(table, role, privileges).join("\n")}\n`;
    },
    generateChangesTableRoleGrantsScript: function(table, role, changes) {
        let privileges = [];
        if (memory.config.options.schemaCompare.grants) {
            if (changes.hasOwnProperty("select"))
                privileges.push(
                    `${changes.select ? "GRANT" : "REVOKE"} SELECT ON TABLE ${table} ${changes.select ? "TO" : "FROM"} ${role};${
                        hints.potentialRoleMissing
                    }`,
                );

            if (changes.hasOwnProperty("insert"))
                privileges.push(
                    `${changes.insert ? "GRANT" : "REVOKE"} INSERT ON TABLE ${table} ${changes.insert ? "TO" : "FROM"} ${role};${
                        hints.potentialRoleMissing
                    }`,
                );

            if (changes.hasOwnProperty("update"))
                privileges.push(
                    `${changes.update ? "GRANT" : "REVOKE"} UPDATE ON TABLE ${table} ${changes.update ? "TO" : "FROM"} ${role};${
                        hints.potentialRoleMissing
                    }`,
                );

            if (changes.hasOwnProperty("delete"))
                privileges.push(
                    `${changes.delete ? "GRANT" : "REVOKE"} DELETE ON TABLE ${table} ${changes.delete ? "TO" : "FROM"} ${role};${
                        hints.potentialRoleMissing
                    }`,
                );

            if (changes.hasOwnProperty("truncate"))
                privileges.push(
                    `${changes.truncate ? "GRANT" : "REVOKE"} TRUNCATE ON TABLE ${table} ${changes.truncate ? "TO" : "FROM"} ${role};${
                        hints.potentialRoleMissing
                    }`,
                );

            if (changes.hasOwnProperty("references"))
                privileges.push(
                    `${changes.references ? "GRANT" : "REVOKE"} REFERENCES ON TABLE ${table} ${changes.references ? "TO" : "FROM"} ${role};${
                        hints.potentialRoleMissing
                    }`,
                );

            if (changes.hasOwnProperty("trigger"))
                privileges.push(
                    `${changes.trigger ? "GRANT" : "REVOKE"} TRIGGER ON TABLE ${table} ${changes.trigger ? "TO" : "FROM"} ${role};${
                        hints.potentialRoleMissing
                    }`,
                );
        }

        return `\n${privileges.join("\n")}\n`;
    },
    generateChangeTableOwnerScript: function(table, owner) {
        if (memory.config.options.schemaCompare.grants) {
            return `\nALTER ${memory.config.options.schemaCompare.idempotentScript ? "TABLE IF EXISTS" : "TABLE"} ${table} OWNER TO ${owner};\n`;
        }
        return '';
    },
    generateCreateViewScript: function(view, schema) {
        //Generate privileges script
        let privileges = [];
        if (memory.config.options.schemaCompare.grants) {
            privileges.push(
                `ALTER ${memory.config.options.schemaCompare.idempotentScript ? "VIEW IF EXISTS" : "VIEW"} ${view} OWNER TO ${schema.owner};`,
            );
            for (let role in schema.privileges) {
                privileges = privileges.concat(this.__generateTableGrantsDefinition(view, role, schema.privileges[role]));
            }
        }
        return `\nCREATE ${memory.config.options.schemaCompare.idempotentScript ? "OR REPLACE VIEW" : "VIEW"} ${view} AS ${
            schema.definition
        }\n${privileges.join("\n")}\n`;
    },
    generateDropViewScript: function(view) {
        return `\nDROP ${memory.config.options.schemaCompare.idempotentScript ? "VIEW IF EXISTS" : "VIEW"} ${view};`;
    },
    generateCreateMaterializedViewScript: function(view, schema) {
        //Generate indexes script

        let indexes = [];
        if (memory.config.options.schemaCompare.indexes) {

            for (let index in schema.indexes) {
                if (schema.indexes.hasOwnProperty(index)) {
                    indexes.push(`\n${schema.indexes[index].definition};\n`);
                }
            }
        }

        //Generate privileges script
        let privileges = [];
        if (memory.config.options.schemaCompare.grants) {
            privileges.push(
                `ALTER ${memory.config.options.schemaCompare.idempotentScript ? "MATERIALIZED VIEW IF EXISTS" : "MATERIALIZED VIEW"} ${view} OWNER TO ${
                    schema.owner
                };\n`,
            );
            for (let role in schema.privileges) {
                privileges = privileges.concat(this.__generateTableGrantsDefinition(view, role, schema.privileges[role]));
            }
        }
        return `\nCREATE ${
            memory.config.options.schemaCompare.idempotentScript ? "MATERIALIZED VIEW IF NOT EXISTS" : "MATERIALIZED VIEW"
        } ${view} AS ${schema.definition}\n${indexes.join("\n")}\n${privileges.join("\n")}\n`;
    },
    generateDropMaterializedViewScript: function(view) {
        return `\nDROP ${memory.config.options.schemaCompare.idempotentScript ? "MATERIALIZED VIEW IF EXISTS" : "MATERIALIZED VIEW"} ${view};`;
    },
    generateCreateProcedureScript: function(procedure, schema) {
        //Generate privileges script
        let privileges = [];
        if (memory.config.options.schemaCompare.grants) {
            privileges.push(`ALTER FUNCTION ${procedure}(${schema.argTypes}) OWNER TO ${schema.owner};`);
            for (let role in schema.privileges) {
                privileges = privileges.concat(this.__generateProcedureGrantsDefinition(procedure, schema.argTypes, role, schema.privileges[role]));
            }
        }
        return `\n${schema.definition};\n${privileges.join("\n")}\n`;
    },
    generateChangeProcedureScript: function(procedure, schema) {
        return `\nDROP ${memory.config.options.schemaCompare.idempotentScript ? "FUNCTION IF EXISTS" : "FUNCTION"} ${procedure}(${
            schema.argTypes
        });\n${this.generateCreateProcedureScript(procedure, schema)}`;
    },
    generateDropProcedureScript: function(procedure) {
        return `\nDROP ${memory.config.options.schemaCompare.idempotentScript ? "FUNCTION IF EXISTS" : "FUNCTION"} ${procedure};\n`;
    },
    generateProcedureRoleGrantsScript: function(procedure, argTypes, role, privileges) {
        return `\n${this.__generateProcedureGrantsDefinition(procedure, argTypes, role, privileges).join("\n")}`;
    },
    generateChangesProcedureRoleGrantsScript: function(procedure, argTypes, role, changes) {
        let privileges = [];
        if (memory.config.options.schemaCompare.grants) {
            if (changes.hasOwnProperty("execute"))
                privileges.push(
                    `${changes.execute ? "GRANT" : "REVOKE"} EXECUTE ON FUNCTION ${procedure}(${argTypes}) ${changes.execute ? "TO" : "FROM"} ${role};${
                        hints.potentialRoleMissing
                    }`,
                );
        }
        return `\n${privileges.join("\n")}`;
    },
    generateChangeProcedureOwnerScript: function(procedure, argTypes, owner) {
        if (memory.config.options.schemaCompare.grants) {
            return `\nALTER FUNCTION ${procedure}(${argTypes}) OWNER TO ${owner};`;
        }
        return '';
    },
    generateUpdateTableRecordScript: function(table, fields, filterConditions, changes) {
        let updates = [];
        for (let field in changes) {
            updates.push(`"${field}" = ${this.__generateSqlFormattedValue(field, fields, changes[field])}`);
        }

        let conditions = [];
        for (let condition in filterConditions) {
            conditions.push(`"${condition}" = ${this.__generateSqlFormattedValue(condition, fields, filterConditions[condition])}`);
        }

        return `\nUPDATE ${table} SET ${updates.join(", ")} WHERE ${conditions.join(" AND ")};\n`;
    },
    generateInsertTableRecordScript: function(table, record, fields, isIdentityUserValuesAllowed) {
        let fieldNames = [];
        let fieldValues = [];
        for (let field in record) {
            fieldNames.push(`"${field}"`);
            fieldValues.push(this.__generateSqlFormattedValue(field, fields, record[field]));
        }

        let script = `\nINSERT INTO ${table} (${fieldNames.join(", ")}) ${
            isIdentityUserValuesAllowed ? "" : "OVERRIDING SYSTEM VALUE"
        } VALUES (${fieldValues.join(", ")});\n`;
        if (!isIdentityUserValuesAllowed) script = `\n${hints.identityColumnDetected}` + script;
        return script;
    },
    generateDeleteTableRecordScript: function(table, fields, keyFieldsMap) {
        let conditions = [];
        for (let condition in keyFieldsMap) {
            conditions.push(`"${condition}" = ${this.__generateSqlFormattedValue(condition, fields, keyFieldsMap[condition])}`);
        }

        return `\nDELETE FROM ${table} WHERE ${conditions.join(" AND ")};\n`;
    },
    __generateSqlFormattedValue: function(fieldName, fields, value) {
        if (value === null) return "NULL";

        let dataTypeId = fields.find(field => {
            return fieldName === field.name;
        }).dataTypeID;

        let dataTypeName = "";
        let dataTypeCategory = "X";

        let dataTypeIndex = memory.sourceDataTypes.findIndex(dataType => {
            return dataType.oid === dataTypeId;
        });

        if (dataTypeIndex >= 0) {
            dataTypeName = memory.sourceDataTypes[dataTypeIndex].typname;
            dataTypeCategory = memory.sourceDataTypes[dataTypeIndex].typcategory;
        }

        switch (dataTypeCategory) {
            case "D": //DATE TIME
                return `'${value.toISOString()}'`;
            case "A": //ARRAY
            case "R": //RANGE
            case "V": //BIT
            case "S": //STRING
                return `'${value.replace(/'/g, "''")}'`;
            // return `'${value}'`;
            case "B": //BOOL
            case "E": //ENUM
            case "G": //GEOMETRIC
            case "I": //NETWORK ADDRESS
            case "N": //NUMERIC
            case "T": //TIMESPAN
                return value;
            case "U": {
                //USER TYPE
                switch (dataTypeName) {
                    case "jsonb":
                    case "json":
                        return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
                    case "xml":
                        return `'${value.replace(/'/g, "''")}'`;
                    case "uuid":
                        return `'${value.replace(/'/g, "''")}'`;
                    default:
                        throw new Error(`The data type '${dataTypeName}' is not implemented yet!`);
                }
            }
            case "X": //UNKNOWN
            case "P": //PSEUDO TYPE
            case "C": //COMPOSITE TYPE
            default:
                throw new Error(`The data type category '${dataTypeCategory}' is not implemented yet!`);
        }
    },
    generateMergeTableRecord(table, fields, changes, options) {
        let fieldNames = [];
        let fieldValues = [];
        let updates = [];
        for (let field in changes) {
            fieldNames.push(`"${field}"`);
            fieldValues.push(this.__generateSqlFormattedValue(field, fields, changes[field]));
            updates.push(`"${field}" = ${this.__generateSqlFormattedValue(field, fields, changes[field])}`);
        }

        let conflictDefinition = "";
        if (options.constraintName) conflictDefinition = `ON CONSTRAINT ${options.constraintName}`;
        else if (options.uniqueFields && options.uniqueFields.length > 0) conflictDefinition = `("${options.uniqueFields.join('", "')}")`;
        else throw new Error(`Impossible to generate conflict definition for table ${table} record to merge!`);

        return `\nINSERT INTO ${table} (${fieldNames.join(", ")}) VALUES (${fieldValues.join(
            ", ",
        )})\nON CONFLICT ${conflictDefinition}\nDO UPDATE SET ${updates.join(", ")}`;
    },
    generateSetSequenceValueScript(tableName, sequence) {
        return `\nSELECT setval(pg_get_serial_sequence('${tableName}', '${sequence.attname}'), max("${sequence.attname}"), true) FROM ${tableName};\n`;
    },
    generateChangeSequencePropertyScript(sequence, property, value) {
        let definition = "";
        let skip = false;
        switch (property) {
            case "startValue":
                definition = `START WITH ${value}`;
                break;
            case "minValue":
                definition = `MINVALUE ${value}`;
                break;
            case "maxValue":
                definition = `MAXVALUE ${value}`;
                break;
            case "increment":
                definition = `INCREMENT BY ${value}`;
                break;
            case "cacheSize":
                definition = `CACHE ${value}`;
                break;
            case "isCycle":
                definition = `${value ? "" : "NO"} CYCLE`;
                break;
            case "owner":
                if (memory.config.options.schemaCompare.grants) {
                    definition = `OWNER TO ${value}`;
                } else {
                    skip = true;
                }
                break;
        }
        if (skip){
            return '';
        } else {
            return `\nALTER ${
                memory.config.options.schemaCompare.idempotentScript ? "SEQUENCE IF EXISTS" : "SEQUENCE"
            } ${sequence} ${definition};\n`;
        }
    },
    generateChangesSequenceRoleGrantsScript: function(sequence, role, changes) {
        let privileges = [];
        if (memory.config.options.schemaCompare.grants) {
            if (changes.hasOwnProperty("select"))
                privileges.push(
                    `${changes.select ? "GRANT" : "REVOKE"} SELECT ON SEQUENCE ${sequence} ${changes.select ? "TO" : "FROM"} ${role};${
                        hints.potentialRoleMissing
                    }`,
                );

            if (changes.hasOwnProperty("usage"))
                privileges.push(
                    `${changes.usage ? "GRANT" : "REVOKE"} USAGE ON SEQUENCE ${sequence} ${changes.usage ? "TO" : "FROM"} ${role};${
                        hints.potentialRoleMissing
                    }`,
                );

            if (changes.hasOwnProperty("update"))
                privileges.push(
                    `${changes.update ? "GRANT" : "REVOKE"} UPDATE ON SEQUENCE ${sequence} ${changes.update ? "TO" : "FROM"} ${role};${
                        hints.potentialRoleMissing
                    }`,
                );
        }
        return `\n${privileges.join("\n")}`;
    },
    generateSequenceRoleGrantsScript: function(sequence, role, privileges) {
        return `\n${this.__generateSequenceGrantsDefinition(sequence, role, privileges).join("\n")}`;
    },
    generateCreateSequenceScript: function(sequence, schema) {
        //Generate privileges script
        let privileges = [];
        if (memory.config.options.schemaCompare.grants) {
            privileges.push(`ALTER SEQUENCE ${sequence} OWNER TO ${schema.owner};`);
            for (let role in schema.privileges) {
                privileges = privileges.concat(this.__generateSequenceGrantsDefinition(sequence, role, schema.privileges[role]));
            }
        }
        return `\n
CREATE ${memory.config.options.schemaCompare.idempotentScript ? "SEQUENCE IF NOT EXISTS" : "SEQUENCE"} ${sequence} 
\tINCREMENT BY ${schema.increment} 
\tMINVALUE ${schema.minValue}
\tMAXVALUE ${schema.maxValue}
\tSTART WITH ${schema.startValue}
\tCACHE ${schema.cacheSize}
\t${schema.isCycle ? "" : "NO "}CYCLE;
\n${privileges.join("\n")}\n`;
    },
    generateRenameSequenceScript: function(old_name, new_name) {
        return `\nALTER ${
            memory.config.options.schemaCompare.idempotentScript ? "SEQUENCE IF EXISTS" : "SEQUENCE"
        } ${old_name} RENAME TO ${new_name};\n`;
    },
};

