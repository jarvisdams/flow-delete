/**
 * @file flow-delete.js
 * @description Standalone Node.js script to handle flow deletion in a CI/CD pipeline.
 *
 * @param {string} --manifest, -x (required)
 *        Path to the manifest file (package.xml) that will be deployed.
 *
 * @param {string} --destructive-manifest, -d (required)
 *        Path to the destructive changes manifest (destructiveChanges.xml) specifying files to delete.
 *
 * @example
 *   node flow-delete.js --manifest ./package.xml --destructive-manifest ./destructiveChanges.xml
 *
 * @author Jarvis Dams
 * @created 2025-12-17
 * @license MIT
 * @repository https://github.com/jarvisdams/flow-delete
 */

const { spawnSync } = require("node:child_process");
const fs = require("fs");
const path = require("path");

init();

const { XMLParser, XMLBuilder } = require("fast-xml-parser");
const { Command } = require("commander");

const program = new Command();

//ensure manifests are populated
program.requiredOption("-x, --manifest <path>", "manifest file path");
program.requiredOption("-d, --destructive-manifest <path>", "destructive manifest file path");

program.parse();
const params = program.opts();

const packagePath = params.manifest;
const destructivePath = params.destructiveManifest;

let destructiveXml = parse(readFile(destructivePath));
let manifest = parse(readFile(packagePath));

//Deactivate Flows
const existingDefinitions = filterType(manifest, "FlowDefinition")
  ? filterType(manifest, "FlowDefinition").members
  : [];

  
const deletedFlows = filterType(destructiveXml, "Flow").members.map((flow) => {
  //remove version numbers if already present
  return flow.split('-').at(0);
})

if (deletedFlows.length > 0) {
  //Consolidate flowDefinitions
  const flowDefinitions = existingDefinitions ? [...existingDefinitions, ...deletedFlows] : deletedFlows;

  deactivateFlows(deletedFlows);

  //Add Flow Definitions to manifest
  updateManifest(packagePath, flowDefinitions, "FlowDefinition");

  //Update destructive package members to include flow version
  updateManifest(destructivePath, fetchFlowVersions(deletedFlows), "Flow");
} else {
  console.log("Destructive manifest does not contain flows");
}

/**
 * Set FlowDefinition ActiveVersionNumber to 0 for all given flows
 * @param {String[]} flows
 */
function deactivateFlows(flows) {
  //ensure flowDefinition directory exists
  fs.mkdirSync('./force-app/main/default/flowDefinitions', { recursive: true })

  flows.forEach((flow) => {
    const filePath = `./force-app/main/default/flowDefinitions/${flow}.flowDefinition-meta.xml`;
    let fd;
    if (fs.existsSync(filePath)) {
      fd = parse(readFile(filePath)); 
      fd.FlowDefinition.activeVersionNumber = 0;
    } else {
      //create flow definition
      fd = createFlowDefinition();
    }

    writeFile(filePath, toXML(fd));

    console.log(`${flow} - deactivated`);
  });
}

/**
 * Create inactive flow definition file
 */
function createFlowDefinition(){
  return {
    '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
    FlowDefinition: {
      activeVersionNumber: 0,
      '@_xmlns': 'http://soap.sforce.com/2006/04/metadata'
    }
  }
}

/**
 * Update the manifest at the given path to add the members of the given type
 * @param {String} path
 * @param {String[]} members
 * @param {String} type
 */
function updateManifest(path, members, type) {
  let manifest = parse(readFile(path));

  //if manifest is empty set types as array
  manifest.Package.types = manifest.Package.types ?? [];

  const types = Array.isArray(manifest.Package.types) ? manifest.Package.types : [manifest.Package.types];

  const element = types.find((element) => element.name === type);

  if (element) {
    element.members = [...new Set(members)];
  } else {
    types.push({ members: members, name: type });
  }

  manifest.Package.types = types;

  writeFile(path, toXML(manifest));
}

/**
 * Query all flowVersions in org for the given flows and return in deletable format ({flowName}-${flowVersionNumber})
 * @param {String[]} flows
 * @returns String[] formatted
 */
function fetchFlowVersions(flows) {

  const formatted = flows.filter(Boolean).map((flow) => `'${flow}'`).join(",");
  const query = `"SELECT Id, Definition.DeveloperName, VersionNumber, Status FROM Flow WHERE Definition.DeveloperName IN (${formatted})"`;
  const response = spawnSync("sf", ["data", "query", "--use-tooling-api", "--json", "--query", query], {
    encoding: "utf-8",
    shell: true
  });

  const versions = response.output.filter(Boolean).map((entry) => {
    try {
      return JSON.parse(entry.toString("utf-8"));
    } catch (error) {
      return entry.toString("utf-8");
    }
  });

  const formattedFlowNames = versions.at(0).result.records.map((version) => {
    return `${version.Definition.DeveloperName}-${version.VersionNumber}`;
  });

  return formattedFlowNames;
}

/**
 * Find nearest parent directory with a package.json file
 * @param {*} startDir
 * @returns
 */
function findProjectRoot(startDir) {
  let dir = startDir;
  while (dir !== path.parse(dir).root) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.resolve(dir, "..");
  }
  throw new Error("Project root with package.json not found");
}

/**
 * Install dependencies
 */
function init() {
  const projectRoot = findProjectRoot(__dirname);
  const result = spawnSync("npm", ["ci"], { stdio: "inherit", cwd: projectRoot, encoding: "utf-8"});

  if (result.error) {
    console.error("Package installation error:", result.error);
  } else if (result.status !== 0) {
    console.error(`package installation failed with exit code ${result.status}`);
  }

  console.log("packages installed successfully");
}

/**
 * Read file at path and return as a string
 * @param {String} path
 * @returns String
 */
function readFile(path) {
  return fs.readFileSync(path, "utf-8");
}

/**
 * Convert XML string to JSON object using XMLParser
 * @param {*} data
 * @returns
 */
function parse(data) {
  const options = {
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true
  };

  const parser = new XMLParser(options);
  return parser.parse(data);
}

/**
 * Write given data to the given file path
 * Data must be writable to file at path
 * @param {String} path
 * @param {String} data
 */
function writeFile(path, data) {
  fs.writeFileSync(path, data);
}

/**
 * Convert given object into XML format
 * @param {Object} data
 * @returns {String}
 */
function toXML(data) {
  const options = {
    format: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@_"
  };

  const builder = new XMLBuilder(options);
  return builder.build(data);
}

/**
 * Parses the given manifest package and return the given type object
 * @param {Object} manifest
 * @param {String} name
 * @returns {
 *  members: [Object],
 *  name: String
 * }
 */
function filterType(manifest, name) {
  let result = { members: [], name: name };
  //if manifest has no types then return empty array
  if (!manifest.Package?.types) {
    return result;
  }

  const types = Array.isArray(manifest.Package.types) ? manifest.Package.types : [manifest.Package.types];
  const type = types.find((type) => type.name === name);

  if (type) {
    result = type;
    //ensure members is always an array
    result.members = Array.isArray(result.members) ? result.members : [result.members];
  }

  return result;
}

