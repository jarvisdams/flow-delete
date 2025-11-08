const { spawnSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const { XMLParser, XMLBuilder } = installModule('fast-xml-parser');
const { Command } = installModule('commander');

const program = new Command();

//ensure manifests are populated
program.requiredOption('-x, --manifest <path>', 'manifest file path');
program.requiredOption('-d, --destructive-manifest <path>', 'destructive manifest file path');

program.parse();
const params = program.opts();

const packagePath = params.manifest;
const destructivePath = params.destructiveManifest;

let destructiveXml = parse(readFile(destructivePath));
let manifest = parse(readFile(packagePath));

//Deactivate Flows
const existingDefinitions = filterType(manifest, 'FlowDefinition') ? filterType(manifest, 'FlowDefinition').members : [];
const deletedFlows = filterType(destructiveXml, 'Flow').members;

if (deletedFlows.length > 0) {

    //Consolidate flowDefinitions
    const flowDefinitions = existingDefinitions ? [...existingDefinitions, ...deletedFlows] : deletedFlows;

    deactivateFlows(deletedFlows);

    //Add Flow Definitions to manifest
    updateManifest(packagePath, flowDefinitions, 'FlowDefinition');

    //Update destructive package members to include flow version
    updateManifest(destructivePath, fetchFlowVersions(deletedFlows), 'Flow');
}else{
    console.log('Destructive manifest does not contain flows');
}


/**
 * Set FlowDefinition ActiveVersionNumber to 0 for all given flows
 * @param {String[]} flows 
 */
function deactivateFlows(flows) {
    const params = ['project', 'retrieve', 'start'];

    flows.forEach(flow => {
        params.push('--metadata', `flow:${flow}`);
    });

    //Ensure directory has flow definitions for each flow
    spawnSync('sf', params, { stdio: 'ignore', shell: true });

    flows.forEach((flow) => {
        const filePath = `./force-app/main/default/flowDefinitions/${flow}.flowDefinition-meta.xml`;
        let fd = parse(readFile(filePath));

        fd.FlowDefinition.activeVersionNumber = 0;

        writeFile(filePath, toXML(fd));

        console.log(`${flow} - deactivated`);
    });
}

/**
 * Update the manifest at the given path to add the members of the given type
 * @param {String} path 
 * @param {String[]} members 
 * @param {String} type 
 */
function updateManifest(path, members, type) {
    let manifest = parse(readFile(path));

    const types = Array.isArray(manifest.Package.types) ? manifest.Package.types : [manifest.Package.types];

    const element = types.find(element => element.name === type);

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
    const formatted = flows.filter(Boolean).map(flow => `'${flow}'`).join(',');
    const query = `"SELECT Id, Definition.DeveloperName, VersionNumber, Status FROM Flow WHERE Definition.DeveloperName IN (${formatted})"`;
    const response = spawnSync('sf', ['data', 'query', '--use-tooling-api', '--json', '--query', query], { encoding: 'utf-8', shell: true });

    const versions = response.output.filter(Boolean).map((entry) => {
        try {
            return JSON.parse(entry.toString('utf-8'));
        } catch (error) {
            return entry.toString('utf-8');
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
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        dir = path.resolve(dir, '..');
    }
    throw new Error('Project root with package.json not found');
}

/**
 * Install package of given name
 * Recommend adding this package to the repo to prevent installation on each run
 * @param {String} name 
 * @returns 
 */
function installModule(name) {
    const projectRoot = findProjectRoot(__dirname);

    const installedPackages = spawnSync('npm', ['ls', name, '--depth=0'], { stdio: 'ignore', cwd: projectRoot, shell: true });
    if (installedPackages.status === 0) {
        console.log(`${name} package already installed`);
        return require(name);
    }

    const result = spawnSync('npm', ['install', name], { stdio: 'inherit', cwd: projectRoot, shell: true });
    if (result.error) {
        throw new Error(`Failed to install ${name}: ${result.error.message}`);
    }

    return require(name);
}
/**
 * Read file at path and return as a string
 * @param {String} path 
 * @returns String
 */
function readFile(path) {
    return fs.readFileSync(path, 'utf-8');
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
    }

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
    }

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
    let result = { members: [], name: name }
    //if manifest has no types then return empty array
    if (!manifest.Package?.types) {
        return result;
    }

    const types = Array.isArray(manifest.Package.types) ? manifest.Package.types : [manifest.Package.types];
    const type = types.find(type => type.name === name);

    if (type) {
        result = type;
    }

    return result;
}

