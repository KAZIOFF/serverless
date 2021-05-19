'use strict';

const { join } = require('path');
const chalk = require('chalk');
const fsp = require('fs').promises;
const spawn = require('child-process-ext/spawn');
const inquirer = require('@serverless/utils/inquirer');
const resolveConfigurationPath = require('../resolve-configuration-path');
const readConfiguration = require('../../configuration/read');
const resolveVariables = require('../../configuration/variables');
const createFromLocalTemplate = require('../../utils/create-from-local-template');
const npmCommandDeferred = require('../../utils/npm-command-deferred');
const ServerlessError = require('../../serverless-error');
const { downloadTemplateFromRepo } = require('../../utils/downloadTemplateFromRepo');

const isValidServiceName = RegExp.prototype.test.bind(/^[a-zA-Z][a-zA-Z0-9-]{0,100}$/);

const initializeProjectChoices = [
  { name: 'AWS - Node.js - Empty', value: 'aws-node' },
  { name: 'AWS - Node.js - REST API', value: 'aws-node-rest-api' },
  { name: 'AWS - Node.js - Scheduled Task', value: 'aws-node-scheduled-cron' },
  { name: 'AWS - Node.js - SQS Worker', value: 'aws-node-sqs-worker' },
  { name: 'AWS - Node.js - Express API', value: 'aws-node-express-api' },
  { name: 'AWS - Node.js - Express API with DynamoDB', value: 'aws-node-express-dynamodb-api' },

  { name: 'AWS - Python - Empty', value: 'aws-python' },
  { name: 'AWS - Python - REST API', value: 'aws-python-rest-api' },
  { name: 'AWS - Python - Scheduled Task', value: 'aws-python-scheduled-cron' },
  { name: 'AWS - Python - SQS Worker', value: 'aws-python-sqs-worker' },
  { name: 'AWS - Python - Flask API', value: 'aws-python-flask-api' },
  { name: 'AWS - Python - Flask API with DynamoDB', value: 'aws-python-flask-dynamodb-api' },
  { name: 'Other', value: 'other' },
];

const projectTypeChoice = async () =>
  (
    await inquirer.prompt({
      message: 'What do you want to make?',
      type: 'list',
      name: 'projectType',
      choices: initializeProjectChoices,
      pageSize: 13,
    })
  ).projectType;

const INVALID_PROJECT_NAME_MESSAGE =
  'Project name is not valid.\n' +
  '   - It should only contain alphanumeric and hyphens.\n' +
  '   - It should start with an alphabetic character.\n' +
  "   - Shouldn't exceed 128 characters";

const projectNameInput = async (workingDir, projectType) =>
  (
    await inquirer.prompt({
      message: 'What do you want to call this project?',
      type: 'input',
      name: 'projectName',
      default: projectType ? `${projectType}-project` : null,
      validate: async (input) => {
        input = input.trim();
        if (!isValidServiceName(input)) {
          return INVALID_PROJECT_NAME_MESSAGE;
        }

        try {
          await fsp.access(join(workingDir, input));
          return `Path ${input} is already taken`;
        } catch {
          return true;
        }
      },
    })
  ).projectName.trim();

const resolveProjectNameInput = async (options, workingDir, projectType = null) => {
  if (options.name) {
    if (!isValidServiceName(options.name)) {
      throw new ServerlessError(INVALID_PROJECT_NAME_MESSAGE, 'INVALID_PROJECT_NAME');
    }

    let alreadyTaken = false;
    try {
      await fsp.access(join(workingDir, options.name));
      alreadyTaken = true;
    } catch {
      // Pass
    }

    if (alreadyTaken) {
      throw new ServerlessError(
        `Path ${options.name} is already taken`,
        'TARGET_FOLDER_ALREADY_EXISTS'
      );
    }

    return options.name;
  }

  return projectNameInput(workingDir, projectType);
};

module.exports = {
  isApplicable({ options, serviceDir }) {
    const notApplicableOptions = new Set(['name', 'template-path', 'template', 'template-url']);
    if (serviceDir && Object.keys(options).some((key) => notApplicableOptions.has(key))) {
      throw new ServerlessError(
        `Cannot setup a new service when being in context of another service (${[
          ...notApplicableOptions,
        ]
          .map((opt) => `"--${opt}"`)
          .join(', ')} options cannot be applied)`,
        'NOT_APPLICABLE_SERVICE_OPTIONS'
      );
    }

    return !serviceDir;
  },
  async run(context) {
    const workingDir = context.cwd || process.cwd();

    // Validate if user did not provide more than one of: `template', 'template-url` and `template-path` options
    const templateOptions = new Set(['template-path', 'template', 'template-url']);
    if (Object.keys(context.options).filter((key) => templateOptions.has(key)).length > 1) {
      throw new ServerlessError(
        `You can provide only one of: ${[...templateOptions]
          .map((opt) => `"--${opt}"`)
          .join(', ')} options`,
        'MULTIPLE_TEMPLATE_OPTIONS_PROVIDED'
      );
    }

    if (
      !context.options.name &&
      !context.options['template-path'] &&
      !context.options.template &&
      !context.options['template-url']
    ) {
      const isConfirmed = (
        await inquirer.prompt({
          message: 'No project detected. Do you want to create a new one?',
          type: 'list',
          name: 'shouldCreateNewProject',
          choices: ['Yes', 'No'],
        })
      ).shouldCreateNewProject;
      if (isConfirmed !== 'Yes') return;
    }

    let projectDir;
    let projectName;
    if (context.options['template-path']) {
      projectName = await resolveProjectNameInput(context.options, workingDir);
      projectDir = join(workingDir, projectName);
      await createFromLocalTemplate({
        templatePath: context.options['template-path'],
        projectDir,
        projectName,
      });
    } else if (context.options['template-url']) {
      projectName = await resolveProjectNameInput(context.options, workingDir);
      projectDir = join(workingDir, projectName);
      const templateUrl = context.options['template-url'];
      process.stdout.write(`\nDownloading template from provided url: ${templateUrl}...\n`);
      try {
        await downloadTemplateFromRepo(templateUrl, null, projectName, { silent: true });
      } catch (err) {
        if (err.constructor.name !== 'ServerlessError') throw err;

        throw new ServerlessError(
          `Could not download template from provided url. Ensure that the template provided with "--template-url" exists: ${err.message}`,
          'INVALID_TEMPLATE_URL'
        );
      }
    } else {
      let projectType;
      if (context.options.template) {
        projectType = context.options.template;
      } else {
        projectType = await projectTypeChoice();
        if (projectType === 'other') {
          process.stdout.write(
            '\nRun “serverless create --help” to view available templates and create a new project ' +
              'from one of those templates.\n'
          );
          return;
        }
      }
      projectName = await resolveProjectNameInput(context.options, workingDir, projectType);
      projectDir = join(workingDir, projectName);
      const templateUrl = `https://github.com/serverless/examples/tree/master/${projectType}`;
      process.stdout.write(`\nDownloading "${projectType}" template...\n`);
      try {
        await downloadTemplateFromRepo(templateUrl, projectType, projectName, { silent: true });
      } catch (err) {
        if (err.code === 'ENOENT' && context.options.template) {
          throw new ServerlessError(
            'Could not find provided template. Ensure that the template provided with "--template" exists.',
            'INVALID_TEMPLATE'
          );
        }

        if (err.constructor.name !== 'ServerlessError') throw err;

        throw new ServerlessError(
          `Could not download template. Ensure that you are using the latest version of Serverless Framework: ${err.message}`,
          'TEMPLATE_DOWNLOAD_FAILED'
        );
      }
    }

    let hasPackageJson = false;
    try {
      await fsp.access(join(projectDir, 'package.json'));
      hasPackageJson = true;
    } catch {
      // pass
    }

    if (hasPackageJson) {
      process.stdout.write(`\nInstalling dependencies with "npm" in "${projectName}" folder.\n`);
      const npmCommand = await npmCommandDeferred;
      try {
        await spawn(npmCommand, ['install'], { cwd: projectDir });
      } catch (err) {
        if (err.code === 'ENOENT') {
          process.stdout.write(
            `\n${chalk.yellow(
              'Cannot install dependencies as "npm" installation could not be found. Please install npm and run "npm install" in directory of created service.'
            )}\n`
          );
        } else {
          throw new ServerlessError(
            `Cannot install dependencies: ${err.message}`,
            'DEPENDENCIES_INSTALL_FAILED'
          );
        }
      }
    }

    try {
      // Try to remove `serverless.template.yml` file from created project if its present
      await fsp.unlink(join(projectDir, 'serverless.template.yml'));
    } catch {
      // pass
    }

    process.stdout.write(
      `\n${chalk.green(`Project successfully created in '${projectName}' folder.`)}\n`
    );
    context.serviceDir = projectDir;
    const configurationPath = await resolveConfigurationPath({ cwd: projectDir, options: {} });
    context.configurationFilename = configurationPath.slice(projectDir.length + 1);
    context.configuration = await readConfiguration(configurationPath);
    await resolveVariables(context);
  },
};