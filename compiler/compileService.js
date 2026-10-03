'use strict';

const solc = require('solc');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const { Logger } = require('../utils/logger');

const logger = new Logger('compiler');

/**
 * CompileService — Compiles Solidity contracts with:
 * - Import resolution (OpenZeppelin, local files)
 * - Multi-file compilation
 * - Error/warning reporting
 */
class CompileService {
  constructor() {
    this.cacheDir = path.join(os.homedir(), '.local', 'share', 'polonio', 'compiler-cache');
    this._ensureDir(this.cacheDir);
  }

  /**
   * Compile Solidity source code.
   * @param {string|object} source - Source code string or sources object {filename: content}
   * @param {string} version - Solidity version (e.g., '0.8.20'). Defaults to embedded.
   * @param {object} options - Additional options
   * @param {string} options.basePath - Base path for resolving local imports
   * @param {string} options.evmVersion - EVM version target
   * @returns {{ success, contracts, errors, warnings }}
   */
  async compile(source, version = null, options = {}) {
    const { basePath = null, evmVersion = 'paris' } = options;

    // Build sources object
    let sources;
    if (typeof source === 'string') {
      sources = { 'Contract.sol': { content: source } };
    } else {
      sources = {};
      for (const [filename, content] of Object.entries(source)) {
        sources[filename] = { content };
      }
    }

    // Build input
    const input = {
      language: 'Solidity',
      sources,
      settings: {
        evmVersion,
        optimizer: { enabled: true, runs: 200 },
        outputSelection: {
          '*': {
            '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'evm.methodIdentifiers'],
          },
        },
      },
    };

    // Import resolver callback
    const importCallback = this._createImportResolver(basePath);

    // Compile
    const outputRaw = solc.compile(JSON.stringify(input), { import: importCallback });
    const output = JSON.parse(outputRaw);

    // Parse results
    const errors = [];
    const warnings = [];

    if (output.errors) {
      for (const err of output.errors) {
        if (err.severity === 'error') {
          errors.push({
            message: err.formattedMessage || err.message,
            sourceLocation: err.sourceLocation,
          });
        } else {
          warnings.push({
            message: err.formattedMessage || err.message,
            sourceLocation: err.sourceLocation,
          });
        }
      }
    }

    if (errors.length > 0) {
      return { success: false, contracts: null, errors, warnings };
    }

    // Extract compiled contracts
    const contracts = {};
    if (output.contracts) {
      for (const [file, fileContracts] of Object.entries(output.contracts)) {
        for (const [name, contractData] of Object.entries(fileContracts)) {
          contracts[name] = {
            abi: contractData.abi,
            bytecode: contractData.evm.bytecode.object,
            deployedBytecode: contractData.evm.deployedBytecode.object,
            methodIdentifiers: contractData.evm.methodIdentifiers,
            sourceFile: file,
          };
        }
      }
    }

    return { success: true, contracts, errors: [], warnings };
  }

  /**
   * Compile a .sol file from disk, resolving all imports.
   * @param {string} filePath - Absolute path to the .sol file
   * @param {object} options - Compilation options
   */
  async compileFile(filePath, options = {}) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const source = fs.readFileSync(filePath, 'utf-8');
    const basePath = path.dirname(filePath);
    const filename = path.basename(filePath);

    return this.compile(
      { [filename]: source },
      options.version || null,
      { ...options, basePath }
    );
  }

  /**
   * Compile multiple .sol files from a directory (challenge deployment).
   * @param {string} dirPath - Directory containing .sol files
   * @param {string[]} fileNames - Ordered list of filenames to compile
   */
  async compileMultiple(dirPath, fileNames) {
    const sources = {};
    for (const filename of fileNames) {
      const filePath = path.join(dirPath, filename);
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      sources[filename] = fs.readFileSync(filePath, 'utf-8');
    }

    return this.compile(sources, null, { basePath: dirPath });
  }

  /**
   * Get available solc versions (from cache or embedded).
   */
  getAvailableVersions() {
    // Return the embedded version info
    return {
      current: solc.version(),
      embedded: solc.version(),
    };
  }

  // ─── Private Methods ───────────────────────────────────────────────────────

  /**
   * Creates an import resolver function for solc.
   * Supports:
   * - Local relative imports (./Foo.sol, ../lib/Bar.sol)
   * - OpenZeppelin imports (@openzeppelin/contracts/...)
   * - Node modules style imports
   */
  _createImportResolver(basePath) {
    return (importPath) => {
      // Try local resolution first
      if (basePath) {
        const localPath = path.resolve(basePath, importPath);
        if (fs.existsSync(localPath)) {
          return { contents: fs.readFileSync(localPath, 'utf-8') };
        }
      }

      // Try node_modules resolution (for @openzeppelin, etc.)
      const nodeModulePaths = [
        path.join(__dirname, '..', 'node_modules', importPath),
        path.join(process.cwd(), 'node_modules', importPath),
      ];

      for (const modPath of nodeModulePaths) {
        if (fs.existsSync(modPath)) {
          return { contents: fs.readFileSync(modPath, 'utf-8') };
        }
      }

      // Try the shared libraries cache
      const cachePath = path.join(this.cacheDir, 'libs', importPath);
      if (fs.existsSync(cachePath)) {
        return { contents: fs.readFileSync(cachePath, 'utf-8') };
      }

      // Try to resolve @openzeppelin from bundled copies
      if (importPath.startsWith('@openzeppelin/')) {
        const ozPath = path.join(__dirname, '..', 'node_modules', importPath);
        if (fs.existsSync(ozPath)) {
          return { contents: fs.readFileSync(ozPath, 'utf-8') };
        }
      }

      return { error: `File not found: ${importPath}` };
    };
  }

  _ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}

module.exports = { CompileService };
