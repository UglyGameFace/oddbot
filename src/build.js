// src/build.js - BUILD VALIDATION SCRIPT (Corrected & More Robust)
import { readFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

class BuildValidator {
  constructor() {
    this.packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));
    this.errors = [];
    this.warnings = [];
  }

  // This function is now more reliable for build environments.
  validateDependencies() {
    console.log('🔍 Validating dependencies by checking for their folders...');
    const dependencies = { ...this.packageJson.dependencies }; // Only check production deps
    for (const dep of Object.keys(dependencies)) {
      if (!existsSync(`./node_modules/${dep}`)) {
        this.errors.push(`Dependency folder for '${dep}' not found. Installation may have failed.`);
      }
    }
  }

  validateEnvironment() {
    console.log('🔍 Validating environment configuration...');
    // This check runs on the build server. In production, variables are injected at runtime.
    // It's okay if they are missing here, so we will only show a warning.
    const requiredEnvVars = [
      'TELEGRAM_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'GOOGLE_GEMINI_API_KEY'
    ];
    
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    if (missingVars.length > 0) {
      this.warnings.push(`The following environment variables are not set in the build environment (this is usually okay): ${missingVars.join(', ')}.`);
    }
  }

  validateFileStructure() {
    console.log('🔍 Validating file structure...');
    const requiredFiles = [
      'src/bot.js', 'src/config/env.js', 'src/services/databaseService.js',
      'src/services/aiService.js', 'src/workers/oddsIngestion.js'
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
