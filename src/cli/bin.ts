#!/usr/bin/env node
import { main } from './index.ts'

process.exitCode = await main()
