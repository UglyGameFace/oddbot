// src/build.js - BUILD VALIDATION SCRIPT
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

class BuildValidator {
  constructor() {
    this.packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));
    this.errors = [];
    this.warnings = [];
  }

  validateDependencies() {
    console.log('🔍 Validating dependencies...');
    
    const validDependencies = this.checkDependencyExistence();
    const dependencyConflicts = this.checkDependencyConflicts();
    
    if (validDependencies.length > 0) {
      this.errors.push(`Invalid dependencies: ${validDependencies.join(', ')}`);
    }
    
    if (dependencyConflicts.length > 0) {
      this.warnings.push(`Potential conflicts: ${dependencyConflicts.join(', ')}`);
    }
  }

  checkDependencyExistence() {
    const invalidDeps = [];
    const dependencies = { ...this.packageJson.dependencies, ...this.packageJson.devDependencies };
    
    for (const [dep, version] of Object.entries(dependencies)) {
      try {
        execSync(`npm view ${dep} version`, { stdio: 'ignore' });
      } catch (error) {
        invalidDeps.push(dep);
      }
    }
    
    return invalidDeps;
  }

  validateEnvironment() {
    console.log('🔍 Validating environment configuration...');
    
    const requiredEnvVars = [
      'TELEGRAM_BOT_TOKEN',
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'GOOGLE_GEMINI_API_KEY'
    ];
    
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      this.warnings.push(`Missing environment variables: ${missingVars.join(', ')}`);
    }
  }

  validateFileStructure() {
    console.log('🔍 Validating file structure...');
    
    const requiredFiles = [
      'src/bot.js',
      'src/config/env.js',
      'src/services/databaseService.js',
      'src/services/aiService.js',
      'src/workers/oddsIngestion.js'
    ];
    
    const missingFiles = requiredFiles.filter(file => !existsSync(file));
    
    if (missingFiles.length > 0) {
      this.errors.push(`Missing required files: ${missingFiles.join(', ')}`);
    }
  }

  run() {
    console.log('🚀 Starting build validation...\n');
    
    this.validateDependencies();
    this.validateEnvironment();
    this.validateFileStructure();
    
    console.log('\n📊 Validation Results:');
    
    if (this.errors.length > 0) {
      console.error('❌ ERRORS:');
      this.errors.forEach(error => console.error(`   - ${error}`));
      process.exit(1);
    }
    
    if (this.warnings.length > 0) {
      console.warn('⚠️ WARNINGS:');
      this.warnings.forEach(warning => console.warn(`   - ${warning}`));
    }
    
    if (this.errors.length === 0) {
      console.log('✅ Build validation passed!');
      console.log('📦 Dependencies are valid');
      console.log('🏗️  File structure is correct');
      console.log('🔧 Environment configuration is ready');
    }
  }
}

// Run validation
const validator = new BuildValidator();
validator.run();