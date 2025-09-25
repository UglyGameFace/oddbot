// src/build.js - BUILD VALIDATION SCRIPT (Corrected)
import { readFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

class BuildValidator {
  constructor() {
    this.packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));
    this.errors = [];
    this.warnings = [];
  }

  validateDependencies() {
    console.log('🔍 Validating dependencies...');
    const dependencies = { ...this.packageJson.dependencies, ...this.packageJson.devDependencies };
    for (const dep of Object.keys(dependencies)) {
      try {
        // A simple check to see if the module path can be resolved
        require.resolve(dep);
      } catch (error) {
        this.errors.push(`Dependency '${dep}' not found. Please run 'npm install'.`);
      }
    }
  }

  validateEnvironment() {
    console.log('🔍 Validating environment configuration...');
    const requiredEnvVars = [
      'TELEGRAM_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_ANON_KEY',
      'GOOGLE_GEMINI_API_KEY', 'SENTRY_DSN', 'REDIS_URL'
    ];
    
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    if (missingVars.length > 0) {
      this.warnings.push(`Missing recommended environment variables: ${missingVars.join(', ')}.`);
    }
  }

  validateFileStructure() {
    console.log('🔍 Validating file structure...');
    const requiredFiles = [
      'src/bot.js', 'src/config/env.js', 'src/services/aiService.js',
      'src/services/databaseService.js', 'src/services/oddsService.js',
      'src/handlers/startHandler.js', 'src/workers/oddsIngestion.js'
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
    
    if (this.warnings.length > 0) {
      console.warn('⚠️ WARNINGS:');
      this.warnings.forEach(warning => console.warn(`   - ${warning}`));
    }
    
    if (this.errors.length > 0) {
      console.error('❌ ERRORS: Build validation failed.');
      this.errors.forEach(error => console.error(`   - ${error}`));
      process.exit(1);
    }
    
    console.log('✅ Build validation passed!');
  }
}

const validator = new BuildValidator();
validator.run();
