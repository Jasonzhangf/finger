use std::path::PathBuf;
use kernel_ledger::{backfill_ledger, rebuild_context_history, read_task_digests};
use kernel_ledger::types::*;
use itertools::Itertools;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    
    if args.len() < 2 {
        println!("Usage:");
        println!("  ledger-cli backfill <ledger_path> <digest_output_path>");
        println!("  ledger-cli rebuild <digest_path> <user_message> <budget>");
        println!("  ledger-cli stats <ledger_path>");
        return;
    }
    
    let command = &args[1];
    
    match command.as_str() {
        "backfill" => {
            if args.len() < 4 {
                println!("Usage: ledger-cli backfill <ledger_path> <digest_output_path>");
                return;
            }
            let ledger_path = PathBuf::from(&args[2]);
            let digest_path = PathBuf::from(&args[3]);
            
            println!("Backfilling ledger: {}", ledger_path.display());
            println!("Output to: {}", digest_path.display());
            
            match backfill_ledger(&ledger_path, &digest_path) {
                Ok(count) => println!("Generated {} task digests", count),
                Err(e) => println!("Error: {}", e),
            }
        },
        
        "rebuild" => {
            if args.len() < 5 {
                println!("Usage: ledger-cli rebuild <digest_path> <user_message> <budget>");
                return;
            }
            let digest_path = PathBuf::from(&args[2]);
            let user_message = &args[3];
            let budget: usize = args[4].parse().unwrap_or(20000);
            
            println!("Rebuilding context history from: {}", digest_path.display());
            println!("User message: {}", user_message);
            println!("Budget: {} tokens", budget);
            
            match read_task_digests(&digest_path) {
                Ok(digests) => {
                    // Build global tag table
                    let global_tags: Vec<String> = digests.iter()
                        .flat_map(|d| d.tags.clone())
                        .unique()
                        .collect();
                    
                    let result = rebuild_context_history(&digests, user_message, &global_tags, budget);
                    
                    println!("Rebuild result:");
                    println!("  Total available: {}", result.total_available);
                    println!("  Total filtered: {}", result.total_filtered);
                    println!("  Selected: {}", result.selected_digests.len());
                    println!("  Tokens used: {}", result.tokens_used);
                    println!("  Relevant tags: {:?}", result.relevant_tags);
                    
                    // Print selected digests summary
                    for d in &result.selected_digests {
                        println!("  - Task: {} ({})", d.id, d.timestamp_start);
                        println!("    Tags: {:?}", d.tags);
                        println!("    Goal: {}", d.layers.digest.goal.chars().take(50).collect::<String>());
                        println!("    Result: {}", d.layers.digest.result.chars().take(50).collect::<String>());
                        println!("    Tokens: {}", d.layers.digest.estimated_tokens);
                    }
                },
                Err(e) => println!("Error reading digests: {}", e),
            }
        },
        
        "stats" => {
            if args.len() < 3 {
                println!("Usage: ledger-cli stats <ledger_path>");
                return;
            }
            let ledger_path = PathBuf::from(&args[2]);
            
            use kernel_ledger::reader::read_ledger_entries;
            use kernel_ledger::task_digest::identify_tasks;
            
            match read_ledger_entries(&ledger_path) {
                Ok(entries) => {
                    println!("Ledger stats:");
                    println!("  Total entries: {}", entries.len());
                    
                    let tasks = identify_tasks(&entries);
                    println!("  Total tasks: {}", tasks.len());
                    
                    if tasks.len() > 0 {
                        let total_bytes: usize = tasks.iter()
                            .flat_map(|t| t.turns.iter())
                            .map(|e| e.to_string().len())
                            .sum();
                        
                        let avg_task_bytes = total_bytes / tasks.len();
                        println!("  Total bytes: {}", total_bytes);
                        println!("  Avg task bytes: {}", avg_task_bytes);
                        
                        // Estimate compression ratio
                        let avg_digest_bytes = 1000; // ~1kb per digest
                        let compression_ratio = avg_task_bytes / avg_digest_bytes;
                        println!("  Estimated compression ratio: {}x", compression_ratio);
                        
                        // Count tasks with tags
                        let with_tags = tasks.iter().filter(|t| t.extract_tags().len() > 0).count();
                        println!("  Tasks with tags: {} / {}", with_tags, tasks.len());
                        
                        // Show tag distribution
                        let all_tags: Vec<String> = tasks.iter()
                            .flat_map(|t| t.extract_tags())
                            .collect();
                        let unique_tags: Vec<&String> = all_tags.iter()
                            .unique()
                            .collect();
                        println!("  Unique tags: {}", unique_tags.len());
                        println!("  Tags: {:?}", unique_tags.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "));
                    }
                },
                Err(e) => println!("Error: {}", e),
            }
        },
        
        _ => println!("Unknown command: {}", command),
    }
}
