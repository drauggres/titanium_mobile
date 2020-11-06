/**
 * Appcelerator Titanium Mobile
 * Copyright (c) 2009-2019 by Axway. All Rights Reserved.
 * Licensed under the terms of the Apache Public License.
 * Please see the LICENSE included with this distribution for details.
 */

'use strict';

const util = require('util');
const exec = util.promisify(require('child_process').exec); // eslint-disable-line security/detect-child-process
const fs = require('fs-extra');
const glob = util.promisify(require('glob'));
const path = require('path');
const ejs = require('ejs');
const generateBootstrap = require('./genBootstrap');

const runtimeV8DirPath = path.join(__dirname, '..', 'runtime', 'v8');

// Determine if we're running on a Windows machine.
const isWindows = (process.platform === 'win32');

/**
 * Double quotes given path and escapes double quote characters in file/directory names.
 * @param {String} filePath The path to be double quoted.
 * @return {String} Returns the double quoted path.
 */
function quotePath(filePath) {
	if (!filePath) {
		return '""';
	}
	if (!isWindows) {
		filePath = filePath.replace(/"/g, '\\"');
	}
	return `"${filePath}"`;
}

/**
 * Executes the "gperf" command line tool used to generate a C/C++ file with perfect hashes.
 * @param {String} workingDirPath The directory which all paths will be relative to. Cannot be null.
 * @param {String} inputFilePath Path to the C/C++ file template used to generate the output file with perfect hashes.
 * @param {String} outputFilePath File name and path to the file to be generated by the gperf tool.
 */
async function gperf(workingDirPath, inputFilePath, outputFilePath) {
	// Acquire a path to the "gperf" command line tool.
	let gperfPath = 'gperf';
	if (isWindows) {
		gperfPath = quotePath(path.join(__dirname, '..', '..', 'build', 'win32', 'gperf'));
	}

	// Run the "gperf" command.
	const commandLine = gperfPath + ' -L C++ -E -t ' + quotePath(inputFilePath);
	const { stdout, stderr } = await exec(commandLine, { cwd: workingDirPath });
	if (stderr) {
		throw new Error(`"gperf" failed to process file "${inputFilePath}". Reason: ${stderr}`);
	}
	await fs.writeFile(outputFilePath, stdout);
}

/**
 * Generate a C int array for baking bytes in c header files
 * @param {Buffer} data the bytes from an input JS file
 * @returns {string} the generated bytes as a string
 */
function bufferToCIntArray(data) {
	const indent = '    ';
	let position = 0;
	const split = 30;
	const length = data.length;
	const output = [];
	for (let i = 0; i < length; ++i, ++position) {
		if ((position % split) === 0) {
			output.push('\n' + indent);
		}
		if (position > 0) {
			output.push(',');
		}
		output.push(data.readInt8(i));
	}
	output.push(',0'); // NULL termination
	return output.join('').trim();
}

/**
 * @param {string} headerFilepath the C header to output
 * @param {Map<string, string>} inputFiles the mapping from expected name to JS file to process as input
 */
async function js2c(headerFilepath, inputFiles) {
	const sources = {};
	for (let [ name, file ] of inputFiles) {
		const data = bufferToCIntArray(await fs.readFile(file));
		sources[name] = data;
	}

	const headerTemplate = await fs.readFile(path.join(__dirname, 'KrollJS.h.ejs'), 'utf8');
	const fileContent = ejs.render(headerTemplate, {
		sources
	});
	return fs.writeFile(headerFilepath, fileContent);
}

/**
 * Overwrite "outFile" with "inFile" if file content is different and then removes "inFile".
 * Intended to improve incremental build times by only updating files if they've actually changed.
 * @param {string} inFile Path to the file intended to replace the "outFile".
 * @param {string} outFile Ptah to the destination file to be replaced. Does not have to exist.
 */
async function replaceFileIfDifferent(inFile, outFile) {
	// Do not continue if the 2 files have the same content.
	if (await fs.exists(outFile)) {
		const inFileContent = await fs.readFile(inFile);
		const outFileContent = await fs.readFile(outFile);
		if (inFileContent.toString() === outFileContent.toString()) {
			return fs.unlink(inFile);
		}
	}

	// Move file to destination. Will overwrite if destination already exists.
	return fs.rename(inFile, outFile);
}

/**
 * Generate a "KrollNativeBindings.h" file with perfect hashes via gperf tool.
 * @param {string} outDir dir to place generated KrollNativeBindings.h file
 */
async function generateKrollNativeBindings(outDir) {
	// Note: 2nd argument is inserted into file as-is. Use relative path since absolute may contain user name.
	const headerFilePath = path.join(outDir, 'KrollNativeBindings.h');
	const tempFilePath = headerFilePath + '.temp';
	await gperf(runtimeV8DirPath, 'src/native/KrollNativeBindings.gperf', tempFilePath);
	return replaceFileIfDifferent(tempFilePath, headerFilePath);
}

async function generateBootstrapAndKrollGeneratedBindings(outDir) {
	// Generate "bootstrap.js" and "KrollGeneratedBindings.gperf" files.
	await generateBootstrap(outDir);

	// Generate a "KrollGeneratedBindings.h" file with perfect hashes via gperf tool.
	// Note: 2nd argument is inserted into file as-is. Use relative path since absolute may contain user name.
	const headerFilePath = path.join(outDir, 'KrollGeneratedBindings.h');
	const tempFilePath = headerFilePath + '.temp';
	await gperf(runtimeV8DirPath, 'generated/KrollGeneratedBindings.gperf', tempFilePath);
	return replaceFileIfDifferent(tempFilePath, headerFilePath);
}

/** Generates C/C++ source files containing internal JS files and from gperf templates. */
async function generateSourceCode() {
	const outDir = path.join(runtimeV8DirPath, 'generated');
	await fs.mkdirs(outDir);
	await Promise.all([
		generateKrollNativeBindings(outDir),
		generateBootstrapAndKrollGeneratedBindings(outDir),
	]);

	// Fetch all JS file paths under directory: "./runtime/common/src/js"
	const runtimeCommonDirPath = path.join(__dirname, '..', 'runtime', 'common');
	let filePaths = await glob(
		'*.js',
		{
			cwd: path.join(runtimeCommonDirPath, 'src', 'js'),
			realpath: true
		}
	);

	// Fetch all JS file paths under each module directory: "./modules/<ModuleName>/src/js"
	filePaths = filePaths.concat(await glob(
		'*/src/js/*.js',
		{
			cwd: path.join(__dirname, '..', 'modules'),
			realpath: true
		}
	));
	filePaths.unshift(path.join(outDir, 'bootstrap.js'));

	// Generate a "KrollJS.h" file containing bootstrap.js and all the other baked in js files
	const files = new Map();
	for (const nextPath of filePaths) {
		files.set(path.basename(nextPath, '.js'), nextPath);
	}
	const headerFilePath = path.join(outDir, 'KrollJS.h');
	const tempFilePath = headerFilePath + '.temp';
	await js2c(tempFilePath, files);
	return replaceFileIfDifferent(tempFilePath, headerFilePath);
}

/** Executes the pre-build step. */
async function main() {
	console.log('Running Titanium "prebuild.js" script.');
	// Generate C/C++ source files with JS files embedded in them and from gperf templates.
	return generateSourceCode();
}

if (require.main === module) {
	main()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err);
			process.exit(1);
		});
}
